// texto.ts — extraccion de texto de documentos.
// Estrategia de coste: si el PDF tiene capa de texto suficiente, se usa unpdf
// (gratis). Solo si viene escaneado (sin texto) se manda a Azure Document
// Intelligence Read (OCR de pago). Asi no se paga OCR por documentos nativos.

import { CFG } from "./config";
import { fetchConTimeout } from "./neto";

const MIN_CHARS_NATIVO = 40; // menos de esto por pagina => se considera escaneado

export interface TextoExtraido {
  texto: string;
  paginas: number;
  metodo: "nativo" | "ocr";
}

// 1) Intenta extraer texto nativo con unpdf
async function extraerNativo(buf: Uint8Array): Promise<{ texto: string; paginas: number } | null> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(buf);
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    const texto = Array.isArray(text) ? text.join("\n") : text;
    return { texto: texto ?? "", paginas: totalPages ?? 0 };
  } catch {
    return null;
  }
}

// 2) OCR con Azure Document Intelligence Read (prebuilt-read), modelo asincrono
async function ocrAzure(buf: Uint8Array, contentType: string): Promise<{ texto: string; paginas: number }> {
  const endpoint = CFG.docIntelEndpoint().replace(/\/$/, "");
  const key = CFG.docIntelKey();
  const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`;

  // POST binario -> devuelve Operation-Location para polling
  const post = await fetchConTimeout(analyzeUrl, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": contentType || "application/octet-stream",
    },
    body: buf as any,
  }, 90000);
  if (!post.ok) throw new Error(`DocIntel analyze fallo ${post.status}: ${await post.text()}`);
  const opLoc = post.headers.get("operation-location");
  if (!opLoc) throw new Error("DocIntel no devolvio operation-location");

  // Polling del resultado
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetchConTimeout(opLoc, {
      headers: { "Ocp-Apim-Subscription-Key": key },
    }, 30000);
    if (!res.ok) continue;
    const j: any = await res.json();
    if (j.status === "succeeded") {
      const texto = j.analyzeResult?.content ?? "";
      const paginas = j.analyzeResult?.pages?.length ?? 0;
      return { texto, paginas };
    }
    if (j.status === "failed") throw new Error(`DocIntel fallo: ${JSON.stringify(j.error)}`);
  }
  throw new Error("DocIntel: timeout de polling (>60s)");
}

// Entrada principal: decide nativo vs OCR
export async function extraerTexto(buf: Uint8Array, nombre: string): Promise<TextoExtraido> {
  const esPdf = nombre.toLowerCase().endsWith(".pdf");
  const contentType = esPdf ? "application/pdf" : "application/octet-stream";

  if (esPdf) {
    const nativo = await extraerNativo(buf);
    if (nativo) {
      const charsPorPag = nativo.paginas > 0 ? nativo.texto.length / nativo.paginas : nativo.texto.length;
      if (charsPorPag >= MIN_CHARS_NATIVO) {
        return { texto: nativo.texto, paginas: nativo.paginas, metodo: "nativo" };
      }
    }
  }

  // Escaneado o formato imagen -> OCR
  const ocr = await ocrAzure(buf, contentType);
  return { texto: ocr.texto, paginas: ocr.paginas, metodo: "ocr" };
}
