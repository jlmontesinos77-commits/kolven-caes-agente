// actPreparar.ts — activity prepararPack.
// Modelo "blobs bajo prefijo": el frontend sube al staging cada fichero (ZIP o
// suelto) bajo el prefijo {instancia}/{packId}/. Aqui se listan todos:
//  - un .zip se expande (indice de sus entradas)
//  - un fichero suelto (pdf/img) entra como un documento mas
// Devuelve un indice serializable; el contenido lo lee cada clasificarUnDoc.

import * as df from "durable-functions";
import { InvocationContext } from "@azure/functions";
import JSZip from "jszip";
import { Supa } from "../shared/supa";
import { tenantConfig } from "../shared/config";
import { listarPorPrefijo, descargarBlob } from "../shared/blob";

const EXTS_DOC = [".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".tif"];
const esDoc = (n: string) => EXTS_DOC.some((e) => n.toLowerCase().endsWith(e));

df.app.activity("prepararPack", {
  handler: async (input: { origen: string; trabajoId: string; packId: string }, ctx: InvocationContext) => {
    try {
      const supa = new Supa(tenantConfig(input.origen));

      const packs = await supa.select<any>("caes_pack", `id=eq.${input.packId}&select=*`);
      if (packs.length === 0) return { ok: false, error: `pack ${input.packId} no existe` };
      const pack = packs[0];
      const instanciaId = pack.instancia_id;
      await supa.update("caes_pack", `id=eq.${input.packId}`, { estado: "procesando" });

      // Prefijo del pack en el staging
      const prefijo = pack.blob_path; // el frontend usa {instancia}/{packId}/ como blob_path base
      const blobs = await listarPorPrefijo(prefijo);
      if (blobs.length === 0) return { ok: false, error: `sin ficheros en ${prefijo}` };

      // Construir indice unificado: cada item = {origen:'zip'|'suelto', blob, entrada?, nombre}
      const documentos: any[] = [];
      for (const b of blobs) {
        const lower = b.name.toLowerCase();
        if (lower.endsWith(".zip")) {
          // expandir: listar entradas del zip (sin extraer aun el contenido)
          const buf = await descargarBlob(b.name);
          const zip = await JSZip.loadAsync(buf);
          let idx = 0;
          const entries = Object.values(zip.files).filter((f: any) => !f.dir);
          for (const e of entries) {
            if (esDoc(e.name)) {
              documentos.push({
                fuente: "zip", blob: b.name, indice: idx,
                nombre: e.name.split("/").pop() || e.name,
              });
            }
            idx++;
          }
        } else if (esDoc(b.name)) {
          documentos.push({
            fuente: "suelto", blob: b.name, indice: -1,
            nombre: b.name.split("/").pop() || b.name,
          });
        }
      }

      // Catalogo de tipos activos
      const catalogo = await supa.select<any>(
        "prl_doc_tipo",
        `activo=eq.true&select=clave,ambito,categoria,nombre,aviso_dias_antes&order=orden.asc`
      );

      // Drive y ruta destino (Kolven: KAPPA)
      const obra = await supa.select<any>("prl_obra_meta", `instancia_id=eq.${instanciaId}&select=obra_nombre`);
      const obraNombre = obra[0]?.obra_nombre || `obra_${instanciaId.slice(0, 8)}`;
      const driveId = process.env["KAPPA_DRIVE_ID"] || "";
      const rutaBasePartes = [obraNombre, "CAE", "Clasificado"];

      await supa.update("caes_pack", `id=eq.${input.packId}`, { total_docs: documentos.length });

      return { ok: true, instanciaId, documentos, catalogo, driveId, rutaBasePartes };
    } catch (e: any) {
      ctx.error(`prepararPack fallo: ${e?.message}`);
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
});
