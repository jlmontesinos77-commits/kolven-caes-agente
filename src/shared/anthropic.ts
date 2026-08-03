// anthropic.ts — cliente del modelo con cache_control (ephemeral) y parser tolerante.
import { CFG } from "./config";
import { fetchConTimeout } from "./neto";

export interface BloqueSistema {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface UsoTokens {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface RespuestaIA {
  texto: string;
  uso: UsoTokens;
}

// Documento para clasificación por VISIÓN (Claude lee el PDF/imagen directamente,
// sin OCR intermedio). base64 del fichero + su media_type.
export interface DocumentoVision {
  base64: string;
  mime: string; // application/pdf | image/png | image/jpeg | image/webp | image/gif
}

export async function llamarModelo(
  system: BloqueSistema[],
  userContent: string,
  maxTokens = 1500,
  documento?: DocumentoVision | null
): Promise<RespuestaIA> {
  // Si hay documento, se envía como bloque de visión + el texto; si no, texto solo.
  let content: any = userContent;
  if (documento && documento.base64) {
    const esPdf = documento.mime === "application/pdf";
    const bloqueDoc = esPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: documento.base64 } }
      : { type: "image", source: { type: "base64", media_type: documento.mime, data: documento.base64 } };
    content = [bloqueDoc, { type: "text", text: userContent }];
  }

  const body = {
    model: CFG.anthropicModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
  };

  const r = await fetchConTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": CFG.anthropicKey(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }, 180000);

  if (!r.ok) throw new Error(`Anthropic fallo ${r.status}: ${await r.text()}`);
  const j: any = await r.json();

  const texto = (j.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  const u = j.usage ?? {};
  return {
    texto,
    uso: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheCreate: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    },
  };
}

// Parser tolerante: extrae el primer objeto JSON aunque venga con texto alrededor
export function parseJsonTolerante<T = any>(s: string): T {
  const limpio = s.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(limpio) as T;
  } catch {
    const m = limpio.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`No se pudo parsear JSON de la IA: ${s.slice(0, 200)}`);
  }
}
