// actPreparar.ts — activity prepararPack (con ZIPs anidados recursivos).
// Recorre los blobs del pack. Cada .zip se expande; si dentro hay mas .zip,
// se abren tambien, hasta MAX_PROFUNDIDAD niveles. Cada documento se identifica
// por una "ruta anidada" que clasificarUnDoc usa para volver a extraerlo.

import * as df from "durable-functions";
import { InvocationContext } from "@azure/functions";
import JSZip from "jszip";
import { Supa } from "../shared/supa";
import { tenantConfig } from "../shared/config";
import { listarPorPrefijo, descargarBlob } from "../shared/blob";
import { resolverRutaTrabajo } from "../shared/graph";

const EXTS_DOC = [".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".tif"];
// Ignora basura de macOS: AppleDouble (._archivo) y carpeta __MACOSX
const esBasura = (path: string) => {
  const base = path.split("/").pop() || path;
  return base.startsWith("._") || path.includes("__MACOSX/");
};
const esDoc = (n: string) => !esBasura(n) && EXTS_DOC.some((e) => n.toLowerCase().endsWith(e));
const esZip = (n: string) => !esBasura(n) && n.toLowerCase().endsWith(".zip");
const MAX_PROFUNDIDAD = 5;
const MAX_DOCS = 5000; // guarda anti zip-bomb

// Recorre un JSZip; documentos -> lista; sub-zips -> recursion.
// rutaZip: cadena de entradas zip que llevan hasta este nivel (para reextraer).
async function recorrerZip(
  zip: JSZip,
  blobBase: string,
  rutaZip: string[],
  nivel: number,
  docs: any[],
  pistas: string[]
): Promise<void> {
  if (nivel > MAX_PROFUNDIDAD || docs.length >= MAX_DOCS) return;
  const entries = Object.values(zip.files).filter((f: any) => !f.dir);
  for (const e of entries as any[]) {
    if (docs.length >= MAX_DOCS) break;
    const nombre = e.name.split("/").pop() || e.name;
    if (esDoc(e.name)) {
      docs.push({
        fuente: "zip",
        blob: blobBase,
        rutaZip: rutaZip,          // zips anidados a atravesar
        entrada: e.name,           // ruta de la entrada dentro del ultimo zip
        nombre,
        // pista de empresa: nombres de los zips contenedores (util para clasificar)
        pista: pistas.join(" / ") || null,
      });
    } else if (esZip(e.name)) {
      // Sub-zip: descomprimir y recursar
      const subBuf = await e.async("uint8array");
      const subZip = await JSZip.loadAsync(subBuf);
      const nombreSubZip = (e.name.split("/").pop() || e.name).replace(/\.zip$/i, "");
      await recorrerZip(subZip, blobBase, [...rutaZip, e.name], nivel + 1, docs, [...pistas, nombreSubZip]);
    }
  }
}

df.app.activity("prepararPack", {
  handler: async (input: { origen: string; trabajoId: string; packId: string }, ctx: InvocationContext) => {
    try {
      const supa = new Supa(tenantConfig(input.origen));
      const packs = await supa.select<any>("caes_pack", `id=eq.${input.packId}&select=*`);
      if (packs.length === 0) return { ok: false, error: `pack ${input.packId} no existe` };
      const pack = packs[0];
      const instanciaId = pack.instancia_id;
      await supa.update("caes_pack", `id=eq.${input.packId}`, { estado: "procesando" });

      const prefijo = pack.blob_path;
      const blobs = await listarPorPrefijo(prefijo);
      if (blobs.length === 0) return { ok: false, error: `sin ficheros en ${prefijo}` };

      const documentos: any[] = [];
      for (const b of blobs) {
        if (documentos.length >= MAX_DOCS) break;
        if (esZip(b.name)) {
          const buf = await descargarBlob(b.name);
          const zip = await JSZip.loadAsync(buf);
          const nombreZip = (b.name.split("/").pop() || b.name).replace(/\.zip$/i, "");
          await recorrerZip(zip, b.name, [], 1, documentos, [nombreZip]);
        } else if (esDoc(b.name)) {
          documentos.push({
            fuente: "suelto", blob: b.name, entrada: null, rutaZip: [],
            nombre: b.name.split("/").pop() || b.name, pista: null,
          });
        }
      }

      const catalogo = await supa.select<any>(
        "prl_doc_tipo",
        `activo=eq.true&select=clave,ambito,categoria,nombre,aviso_dias_antes&order=orden.asc`
      );

      // FASE C: ordenar para que los documentos que DEFINEN empresas se procesen
      // primero (apertura de centro de trabajo = contratista; adhesiones al PSS =
      // subcontratas; contratos/altas SS). Asi, cuando llega un diploma o un doc
      // sin empresa clara, la empresa titular del trabajador ya esta resuelta y el
      // documento se archiva bajo la carpeta correcta en una sola pasada.
      // La deteccion es por nombre de archivo/pista (aun no conocemos el tipo real,
      // que lo decide la IA); es una heuristica de ordenacion, no de clasificacion.
      const prioridadEmpresa = (doc: any): number => {
        const t = `${doc.nombre || ""} ${doc.pista || ""}`.toLowerCase();
        // 0 = maxima prioridad (define empresa), 2 = normal
        if (/apertura|centro de trabajo|comunicacion.*apertura|ar_apertura/.test(t)) return 0;
        if (/adhesion|adhesi[oó]n|pss|plan de seguridad|aprobacion.*pss/.test(t)) return 0;
        if (/contrato|alta.*ss|alta.*seguridad social|tgss|rnt|rlc|itc|reta/.test(t)) return 1;
        return 2;
      };
      documentos.sort((a, b) => prioridadEmpresa(a) - prioridadEmpresa(b));
      const numAnclas = documentos.filter((d) => prioridadEmpresa(d) <= 1).length;

      const driveId = process.env["KAPPA_DRIVE_ID"] || "";

      // Resolver ruta base del pedido en KAPPA: {cliente}/{26-XXXX}/{item}/Trabajo/03 CSS
      let rutaBasePartes: string[];
      try {
        const datos = await supa.rpc<any>("caes_datos_pedido", { p_instancia: instanciaId });
        const d = Array.isArray(datos) ? datos[0] : datos;
        const trabajo = await resolverRutaTrabajo(driveId, {
          cliente: d.cliente, numeroPedido: d.numero_pedido, itemCode: d.item_code,
        });
        rutaBasePartes = [...trabajo, "03 CSS"];
      } catch (e: any) {
        ctx.error(`resolverRutaTrabajo fallo, usando fallback: ${e?.message}`);
        // Fallback: no bloquea la clasificacion; archiva en una ruta plana KAPPA
        const obra = await supa.select<any>("prl_obra_meta", `instancia_id=eq.${instanciaId}&select=obra_nombre`);
        rutaBasePartes = [obra[0]?.obra_nombre || `obra_${instanciaId.slice(0,8)}`, "CAE", "03 CSS"];
      }

      await supa.update("caes_pack", `id=eq.${input.packId}`, { total_docs: documentos.length });
      return { ok: true, instanciaId, documentos, catalogo, driveId, rutaBasePartes, numAnclas };
    } catch (e: any) {
      ctx.error(`prepararPack fallo: ${e?.message}`);
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
});
