// actPreparar.ts — activity prepararPack.
// Descarga el ZIP del staging, lo lista (indice de documentos), carga el catalogo
// de tipos y resuelve el drive/ruta de destino. Devuelve un objeto SERIALIZABLE
// (no el contenido de los ficheros: eso lo lee cada clasificarUnDoc de su blob).

import * as df from "durable-functions";
import { InvocationContext } from "@azure/functions";
import JSZip from "jszip";
import { Supa } from "../shared/supa";
import { tenantConfig } from "../shared/config";
import { descargarZip } from "../shared/blob";

const EXTS_DOC = [".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".tif"];

df.app.activity("prepararPack", {
  handler: async (input: { origen: string; trabajoId: string; packId: string }, ctx: InvocationContext) => {
    try {
      const supa = new Supa(tenantConfig(input.origen));

      // 1) Cargar el pack
      const packs = await supa.select<any>("caes_pack", `id=eq.${input.packId}&select=*`);
      if (packs.length === 0) return { ok: false, error: `pack ${input.packId} no existe` };
      const pack = packs[0];
      const instanciaId = pack.instancia_id;

      await supa.update("caes_pack", `id=eq.${input.packId}`, { estado: "procesando" });

      // 2) Descargar y listar el ZIP
      const buf = await descargarZip(pack.blob_path);
      const zip = await JSZip.loadAsync(buf);
      const documentos: { nombre: string; indice: number }[] = [];
      let idx = 0;
      zip.forEach((path, entry) => {
        if (entry.dir) return;
        const lower = path.toLowerCase();
        if (EXTS_DOC.some((e) => lower.endsWith(e))) {
          documentos.push({ nombre: path.split("/").pop() || path, indice: idx });
        }
        idx++;
      });

      // 3) Catalogo de tipos activos de la instancia
      const catalogo = await supa.select<any>(
        "prl_doc_tipo",
        `activo=eq.true&select=clave,ambito,categoria,nombre,aviso_dias_antes&order=orden.asc`
      );

      // 4) Resolver drive y ruta de destino
      //    Kolven: KAPPA_DRIVE_ID via env + carpeta de la obra.
      //    (SaaS resolveria storage_conector; se añade cuando se pruebe SaaS)
      const obra = await supa.select<any>(
        "prl_obra_meta",
        `instancia_id=eq.${instanciaId}&select=obra_nombre`
      );
      const obraNombre = obra[0]?.obra_nombre || `obra_${instanciaId.slice(0, 8)}`;
      const driveId = process.env["KAPPA_DRIVE_ID"] || "";
      const rutaBasePartes = [obraNombre, "CAE", "Clasificado"];

      await supa.update("caes_pack", `id=eq.${input.packId}`, { total_docs: documentos.length });

      return {
        ok: true,
        instanciaId,
        blobPath: pack.blob_path,
        documentos,
        catalogo,
        driveId,
        rutaBasePartes,
      };
    } catch (e: any) {
      ctx.error(`prepararPack fallo: ${e?.message}`);
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
});
