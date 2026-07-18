// actClasificar.ts — activity clasificarUnDoc (fan-out, soporta zips anidados).
// doc.rutaZip = [zip1, zip2, ...] entradas zip a atravesar desde el blob base.
// doc.entrada = ruta del fichero dentro del ultimo zip.
// Cache de zips por clave (blob + rutaZip) dentro de la instancia de worker.

import * as df from "durable-functions";
import { InvocationContext } from "@azure/functions";
import JSZip from "jszip";
import { Supa } from "../shared/supa";
import { tenantConfig } from "../shared/config";
import { descargarBlob } from "../shared/blob";
import { construirSystem, DocTipoCatalogo } from "../shared/prompt";
import { clasificarDocumento, CtxDoc } from "../shared/clasificar";

const zipCache = new Map<string, JSZip>();
function cacheGuard() { if (zipCache.size > 6) { const k = zipCache.keys().next().value; if (k) zipCache.delete(k); } }

async function getZipBase(blob: string): Promise<JSZip> {
  const hit = zipCache.get(blob);
  if (hit) return hit;
  const buf = await descargarBlob(blob);
  const zip = await JSZip.loadAsync(buf);
  zipCache.set(blob, zip); cacheGuard();
  return zip;
}

// Navega la cadena de zips anidados hasta el zip que contiene 'entrada'
async function resolverZipFinal(blob: string, rutaZip: string[]): Promise<JSZip> {
  let zip = await getZipBase(blob);
  let clave = blob;
  for (const entradaZip of rutaZip) {
    clave += "|" + entradaZip;
    const hit = zipCache.get(clave);
    if (hit) { zip = hit; continue; }
    const f = zip.file(entradaZip);
    if (!f) throw new Error(`sub-zip no hallado: ${entradaZip}`);
    const sub = await JSZip.loadAsync(await f.async("uint8array"));
    zipCache.set(clave, sub); cacheGuard();
    zip = sub;
  }
  return zip;
}

df.app.activity("clasificarUnDoc", {
  handler: async (input: any, ctx: InvocationContext) => {
    const { origen, packId, instanciaId, driveId, rutaBasePartes, catalogo, doc } = input;
    try {
      const supa = new Supa(tenantConfig(origen));

      let contenido: Uint8Array;
      if (doc.fuente === "zip") {
        const zip = await resolverZipFinal(doc.blob, doc.rutaZip || []);
        const f = zip.file(doc.entrada);
        if (!f) return { archivo: doc.nombre, ok: false, revision: true, error: `entrada no hallada: ${doc.entrada}` };
        contenido = await f.async("uint8array");
      } else {
        contenido = new Uint8Array(await descargarBlob(doc.blob));
      }

      const tiposConId = await supa.select<any>("prl_doc_tipo", `activo=eq.true&select=id,clave,aviso_dias_antes,categoria,ambito`);
      const claveToId = new Map<string, { id: string; aviso: number; categoria: string | null; ambito: string | null }>();
      for (const t of tiposConId) claveToId.set(t.clave, { id: t.id, aviso: t.aviso_dias_antes ?? 30, categoria: t.categoria ?? null, ambito: t.ambito ?? null });

      const ctxDoc: CtxDoc = {
        supa, system: construirSystem(catalogo as DocTipoCatalogo[]),
        instanciaId, packId, driveId, rutaBasePartes, claveToId,
      };

      // Pasar pista de empresa (nombre de zips contenedores) al nombre para ayudar a la IA
      const nombreConPista = doc.pista ? `${doc.nombre} [origen: ${doc.pista}]` : doc.nombre;
      const res = await clasificarDocumento(ctxDoc, nombreConPista, contenido);

      try {
        const packs = await supa.select<any>("caes_pack", `id=eq.${packId}&select=procesados`);
        await supa.update("caes_pack", `id=eq.${packId}`, { procesados: (packs[0]?.procesados ?? 0) + 1 });
      } catch { /* no critico */ }

      return { ...res, archivo: doc.nombre };
    } catch (e: any) {
      ctx.error(`clasificarUnDoc ${doc?.nombre} fallo: ${e?.message}`);
      return { archivo: doc?.nombre, ok: false, revision: true, error: String(e?.message ?? e) };
    }
  },
});
