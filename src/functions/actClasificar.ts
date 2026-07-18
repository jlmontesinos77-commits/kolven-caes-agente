// actClasificar.ts — activity clasificarUnDoc (la del fan-out).
// Cada instancia baja el ZIP UNA vez desde blob, extrae SU fichero por indice
// y lo clasifica. Nota de coste: el ZIP se cachea en el disco local de la
// instancia entre invocaciones consecutivas para no rebajarlo cada vez.

import * as df from "durable-functions";
import { InvocationContext } from "@azure/functions";
import JSZip from "jszip";
import { Supa } from "../shared/supa";
import { tenantConfig } from "../shared/config";
import { descargarZip } from "../shared/blob";
import { construirSystem, DocTipoCatalogo } from "../shared/prompt";
import { clasificarDocumento, CtxDoc } from "../shared/clasificar";

// cache de ZIP por blobPath dentro de la misma instancia de worker
const zipCache = new Map<string, JSZip>();

async function getZip(blobPath: string): Promise<JSZip> {
  const hit = zipCache.get(blobPath);
  if (hit) return hit;
  const buf = await descargarZip(blobPath);
  const zip = await JSZip.loadAsync(buf);
  zipCache.set(blobPath, zip);
  // evita crecer sin limite
  if (zipCache.size > 3) {
    const first = zipCache.keys().next().value;
    if (first) zipCache.delete(first);
  }
  return zip;
}

df.app.activity("clasificarUnDoc", {
  handler: async (input: any, ctx: InvocationContext) => {
    const {
      origen, packId, instanciaId, driveId, rutaBasePartes,
      catalogo, blobPath, archivo, indice,
    } = input;

    try {
      const supa = new Supa(tenantConfig(origen));

      // Extraer el fichero concreto del ZIP
      const zip = await getZip(blobPath);
      const entries = Object.values(zip.files).filter((f: any) => !f.dir);
      const entry: any = entries[indice];
      if (!entry) {
        return { archivo, ok: false, revision: true, error: `indice ${indice} no encontrado` };
      }
      const contenido = await entry.async("uint8array");

      // Mapa clave -> {id, aviso}
      const cat = catalogo as DocTipoCatalogo[];
      const claveToId = new Map<string, { id: string; aviso: number }>();
      // el id real lo necesitamos: recargamos con id (el catalogo del prompt no lo trae)
      const tiposConId = await supa.select<any>(
        "prl_doc_tipo",
        `activo=eq.true&select=id,clave,aviso_dias_antes`
      );
      for (const t of tiposConId) claveToId.set(t.clave, { id: t.id, aviso: t.aviso_dias_antes ?? 30 });

      const ctxDoc: CtxDoc = {
        supa,
        system: construirSystem(cat),
        instanciaId,
        packId,
        driveId,
        rutaBasePartes,
        claveToId,
      };

      const res = await clasificarDocumento(ctxDoc, archivo, contenido);

      // actualizar progreso incremental (best-effort)
      try {
        const packs = await supa.select<any>("caes_pack", `id=eq.${packId}&select=procesados`);
        const proc = (packs[0]?.procesados ?? 0) + 1;
        await supa.update("caes_pack", `id=eq.${packId}`, { procesados: proc });
      } catch { /* no critico */ }

      return res;
    } catch (e: any) {
      ctx.error(`clasificarUnDoc ${archivo} fallo: ${e?.message}`);
      return { archivo, ok: false, revision: true, error: String(e?.message ?? e) };
    }
  },
});
