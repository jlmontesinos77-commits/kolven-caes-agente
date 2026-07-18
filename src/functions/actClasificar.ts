// actClasificar.ts — activity clasificarUnDoc (fan-out).
// Cada doc trae 'fuente': 'zip' (extraer del zip por indice) o 'suelto'
// (descargar el blob directo). El ZIP se cachea por instancia de worker.

import * as df from "durable-functions";
import { InvocationContext } from "@azure/functions";
import JSZip from "jszip";
import { Supa } from "../shared/supa";
import { tenantConfig } from "../shared/config";
import { descargarBlob } from "../shared/blob";
import { construirSystem, DocTipoCatalogo } from "../shared/prompt";
import { clasificarDocumento, CtxDoc } from "../shared/clasificar";

const zipCache = new Map<string, JSZip>();
async function getZip(blob: string): Promise<JSZip> {
  const hit = zipCache.get(blob);
  if (hit) return hit;
  const buf = await descargarBlob(blob);
  const zip = await JSZip.loadAsync(buf);
  zipCache.set(blob, zip);
  if (zipCache.size > 3) {
    const first = zipCache.keys().next().value;
    if (first) zipCache.delete(first);
  }
  return zip;
}

df.app.activity("clasificarUnDoc", {
  handler: async (input: any, ctx: InvocationContext) => {
    const { origen, packId, instanciaId, driveId, rutaBasePartes, catalogo, doc } = input;
    try {
      const supa = new Supa(tenantConfig(origen));

      // Obtener el contenido segun la fuente
      let contenido: Uint8Array;
      if (doc.fuente === "zip") {
        const zip = await getZip(doc.blob);
        const entries = Object.values(zip.files).filter((f: any) => !f.dir);
        const entry: any = entries[doc.indice];
        if (!entry) return { archivo: doc.nombre, ok: false, revision: true, error: `indice ${doc.indice} no hallado` };
        contenido = await entry.async("uint8array");
      } else {
        contenido = new Uint8Array(await descargarBlob(doc.blob));
      }

      // Mapa clave -> {id, aviso}
      const tiposConId = await supa.select<any>("prl_doc_tipo", `activo=eq.true&select=id,clave,aviso_dias_antes`);
      const claveToId = new Map<string, { id: string; aviso: number }>();
      for (const t of tiposConId) claveToId.set(t.clave, { id: t.id, aviso: t.aviso_dias_antes ?? 30 });

      const ctxDoc: CtxDoc = {
        supa,
        system: construirSystem(catalogo as DocTipoCatalogo[]),
        instanciaId, packId, driveId, rutaBasePartes, claveToId,
      };

      const res = await clasificarDocumento(ctxDoc, doc.nombre, contenido);

      // progreso incremental (best-effort)
      try {
        const packs = await supa.select<any>("caes_pack", `id=eq.${packId}&select=procesados`);
        await supa.update("caes_pack", `id=eq.${packId}`, { procesados: (packs[0]?.procesados ?? 0) + 1 });
      } catch { /* no critico */ }

      return res;
    } catch (e: any) {
      ctx.error(`clasificarUnDoc ${doc?.nombre} fallo: ${e?.message}`);
      return { archivo: doc?.nombre, ok: false, revision: true, error: String(e?.message ?? e) };
    }
  },
});
