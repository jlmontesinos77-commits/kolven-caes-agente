// rutasCae.ts — decide la ruta de archivado de cada documento dentro de "03 CSS".
// Estructura:
//   03 CSS/
//     [genericos de obra en raiz]
//     {Empresa}/
//       [docs de empresa]
//       Trabajadores/{Apellidos, Nombre}/{Subcarpeta}/
//       Maquinaria/{matricula}/

export interface DatosRuta {
  ambito: string | null;           // empresa | trabajador | maquinaria | null(obra)
  categoria: string | null;        // categoria del prl_doc_tipo
  claveDocTipo: string | null;
  empresaNombre: string | null;
  trabajadorNombre: string | null; // "Apellidos, Nombre"
  matricula: string | null;
}

// Subcarpeta de trabajador segun la categoria del tipo de documento
function subcarpetaTrabajador(categoria: string | null): string {
  switch (categoria) {
    case "identificacion":
    case "laboral":        return "Personal";
    case "formacion":      return "Formación";
    case "epi":            return "EPIs";
    case "salud":          return "Reconocimiento";
    case "autorizacion":
    case "gruista":        return "Habilitaciones";
    case "acogida":        return "Información";
    default:               return "Personal"; // fallback conservador
  }
}

// Tipos que, aunque el catalogo los marque ambito=trabajador, son de EMPRESA
const CLAVES_DE_EMPRESA = new Set<string>([
  "trabajador.nombramiento_rp", // recurso preventivo = documento de empresa
]);

// Devuelve el array de segmentos de carpeta (relativo a "03 CSS") donde archivar.
// No incluye "03 CSS" (ese lo aporta la ruta base).
export function rutaDentroCss(d: DatosRuta): string[] {
  const emp = (d.empresaNombre || "").trim();

  // Reclasificacion: recurso preventivo -> empresa
  const esDeEmpresa = d.claveDocTipo && CLAVES_DE_EMPRESA.has(d.claveDocTipo);

  // 1) Generico de obra: sin empresa ni trabajador ni maquina -> raiz de 03 CSS
  if (!emp && !d.trabajadorNombre && !d.matricula) {
    return [];
  }

  // Sin empresa pero con entidad: cuelga de una empresa generica
  const empSeg = emp || "_SIN EMPRESA";

  // 2) Maquinaria
  if (d.ambito === "maquinaria" || d.matricula) {
    const mat = (d.matricula || "sin_matricula").trim();
    return [empSeg, "Maquinaria", mat];
  }

  // 3) Trabajador (salvo reclasificados a empresa)
  if (d.trabajadorNombre && !esDeEmpresa) {
    return [empSeg, "Trabajadores", d.trabajadorNombre.trim(), subcarpetaTrabajador(d.categoria)];
  }

  // 4) Empresa (incluye recurso preventivo)
  return [empSeg];
}

// Resuelve la ruta base del pedido en KAPPA ({cliente}/{26-XXXX}/{item}/Trabajo/03 CSS),
// con fallback plano. Compartido por el fan-out (actPreparar) y la subida contextual
// sincrona (starter /api/clasificar-uno) para no duplicar la logica.
import { resolverRutaTrabajo } from "./graph";
import type { Supa } from "./supa";
export async function prepararRutaBase(
  supa: Supa, driveId: string, instanciaId: string,
  log?: (m: string) => void
): Promise<string[]> {
  try {
    const datos = await supa.rpc<any>("caes_datos_pedido", { p_instancia: instanciaId });
    const d = Array.isArray(datos) ? datos[0] : datos;
    const trabajo = await resolverRutaTrabajo(driveId, {
      cliente: d.cliente, numeroPedido: d.numero_pedido, itemCode: d.item_code,
    });
    return [...trabajo, "03 CSS"];
  } catch (e: any) {
    log?.(`prepararRutaBase fallback: ${e?.message}`);
    const obra = await supa.select<any>("prl_obra_meta", `instancia_id=eq.${instanciaId}&select=obra_nombre`);
    return [obra[0]?.obra_nombre || `obra_${instanciaId.slice(0, 8)}`, "CAE", "03 CSS"];
  }
}
