// starter.ts — dos endpoints HTTP:
//  /api/arrancar     -> recibe el push de Supabase (doble auth) y lanza el orchestrator
//  /api/sas-subida   -> genera una SAS de subida directa a Blob (key nunca sale de Azure)

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import * as df from "durable-functions";
import { CFG, tenantConfig } from "../shared/config";
import { generarSasSubida, descargarBlob } from "../shared/blob";
import { construirSystem } from "../shared/prompt";
import { clasificarDocumento, CtxDoc } from "../shared/clasificar";

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
  const packId = body.pack_id;
  const nombre = (body.nombre ?? "documento").replace(/[^\w.\-]/g, "_");
  if (!instanciaId || !packId) return { status: 400, jsonBody: { error: "falta instancia_id o pack_id" } };

  // prefijo del pack: {instancia}/{packId}/  -> el agente lista todo lo de aqui
  const blobPath = `${instanciaId}/${packId}/${Date.now()}_${nombre}`;
  const { url } = generarSasSubida(blobPath, 120);
  return { status: 200, jsonBody: { upload_url: url, blob_path: blobPath, container: CFG.blobContainer() } };
}

// --- Clasificar UN documento de forma SINCRONA (subida contextual desde el panel) ---
// El documento ya esta subido al blob. Recibe el titular FIJADO (empresa/trabajador/
// maquina) que el usuario eligio en el panel. No pasa por Durable: clasifica y responde.
async function clasificarUno(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-agente-secret");
  if (secret !== CFG.agenteSecret()) return { status: 401, jsonBody: { error: "unauthorized" } };

  const body: any = await req.json().catch(() => ({}));
  const origen = body.origen ?? "kolven";
  const instanciaId = body.instancia_id;
  const packId = body.pack_id ?? null;
  const blobPath = body.blob_path;
  const nombre = body.nombre ?? (blobPath ? blobPath.split("/").pop() : "documento");
  const empresaFijada = body.empresa_id ?? null;
  const trabajadorFijado = body.trabajador_id ?? null;
  const maquinariaFijada = body.maquinaria_id ?? null;
  if (!instanciaId || !blobPath) return { status: 400, jsonBody: { error: "falta instancia_id o blob_path" } };

  try {
    const { Supa } = await import("../shared/supa");
    const { prepararRutaBase } = await import("../shared/rutasCae");
    const supa = new Supa(tenantConfig(origen));

    const contenido = new Uint8Array(await descargarBlob(blobPath));
    const driveId = process.env["KAPPA_DRIVE_ID"] || "";
    const rutaBasePartes = await prepararRutaBase(supa, driveId, instanciaId, (m) => ctx.log(m));

    const catalogo = await supa.select<any>("prl_doc_tipo", `activo=eq.true&select=clave,ambito,categoria,nombre,aviso_dias_antes&order=orden.asc`);
    const tiposConId = await supa.select<any>("prl_doc_tipo", `activo=eq.true&select=id,clave,aviso_dias_antes,categoria,ambito`);
    const claveToId = new Map<string, { id: string; aviso: number; categoria: string | null; ambito: string | null }>();
    for (const t of tiposConId) claveToId.set(t.clave, { id: t.id, aviso: t.aviso_dias_antes ?? 30, categoria: t.categoria ?? null, ambito: t.ambito ?? null });

    const ctxDoc: CtxDoc = {
      supa, system: construirSystem(catalogo as any),
      instanciaId, packId: packId ?? instanciaId, driveId, rutaBasePartes, claveToId,
      empresaFijada, trabajadorFijado, maquinariaFijada,
    };
    const resultado = await clasificarDocumento(ctxDoc, nombre, contenido, null);
    return { status: 200, jsonBody: { ok: resultado.ok, resultado } };
  } catch (e: any) {
    ctx.error(`clasificarUno fallo: ${e?.message}`);
    return { status: 500, jsonBody: { ok: false, error: e?.message ?? "error" } };
  }
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

app.http("clasificar-uno", {
  route: "clasificar-uno",
  methods: ["POST"],
  authLevel: "function",
  handler: clasificarUno,
});
