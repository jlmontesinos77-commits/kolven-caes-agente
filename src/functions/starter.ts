// starter.ts — dos endpoints HTTP:
//  /api/arrancar     -> recibe el push de Supabase (doble auth) y lanza el orchestrator
//  /api/sas-subida   -> genera una SAS de subida directa a Blob (key nunca sale de Azure)

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import * as df from "durable-functions";
import { CFG } from "../shared/config";
import { generarSasSubida } from "../shared/blob";

// --- Arrancar orchestrator (llamado por el trigger de Supabase) ---
async function arrancar(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-agente-secret");
  if (secret !== CFG.agenteSecret()) {
    return { status: 401, jsonBody: { error: "unauthorized" } };
  }
  const origen = req.query.get("origen") ?? "kolven";
  const client = df.getClient(ctx);
  const instanceId = await client.startNew("orchestrator", { input: { origen } });
  ctx.log(`Orchestrator arrancado ${instanceId} origen=${origen}`);
  return { status: 202, jsonBody: { instanceId, origen } };
}

// --- Generar SAS de subida (llamado por el frontend) ---
async function sasSubida(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-agente-secret");
  if (secret !== CFG.agenteSecret()) {
    return { status: 401, jsonBody: { error: "unauthorized" } };
  }
  const body: any = await req.json().catch(() => ({}));
  const instanciaId = body.instancia_id;
  const nombreZip = (body.nombre_zip ?? "paquete.zip").replace(/[^\w.\-]/g, "_");
  if (!instanciaId) return { status: 400, jsonBody: { error: "falta instancia_id" } };

  // ruta unica: {instancia}/{timestamp}_{nombre}
  const blobPath = `${instanciaId}/${Date.now()}_${nombreZip}`;
  const { url } = generarSasSubida(blobPath, 60);
  return { status: 200, jsonBody: { upload_url: url, blob_path: blobPath, container: CFG.blobContainer() } };
}

app.http("arrancar", {
  route: "arrancar",
  methods: ["POST"],
  authLevel: "function",
  extraInputs: [df.input.durableClient()],
  handler: arrancar,
});

app.http("sas-subida", {
  route: "sas-subida",
  methods: ["POST"],
  authLevel: "function",
  handler: sasSubida,
});
