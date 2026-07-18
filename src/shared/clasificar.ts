// clasificar.ts — procesa UN documento de principio a fin.
// Diseñado para ejecutarse en paralelo (fan-out). try/catch propio: un doc que
// falla no tumba el lote.

import { Supa } from "./supa";
import { extraerTexto } from "./texto";
import { llamarModelo, parseJsonTolerante, UsoTokens } from "./anthropic";
import { BloqueSistema } from "./anthropic";
import { construirUser } from "./prompt";
import { subirArchivo } from "./graph";
import { rutaDentroCss } from "./rutasCae";

export interface ClasificacionIA {
  clave_doc_tipo: string | null;
  ambito: string | null;
  empresa_cif: string | null;
  empresa_nombre: string | null;
  trabajador_dni: string | null;
  trabajador_nombre: string | null;
  trabajador_apellidos: string | null;
  matricula_maquina: string | null;
  fecha_emision: string | null;
  fecha_validez: string | null;
  mes_referencia: string | null;
  confidence: number;
  alertas: string[];
}

export interface ResultadoDoc {
  archivo: string;
  ok: boolean;
  clave: string | null;
  confidence: number;
  revision: boolean;
  estado: string | null;
  error?: string;
  uso?: UsoTokens;
}

const UMBRAL_REVISION = 0.7;

// Calcula el estado del prl_documento a partir de la fecha de validez
function calcularEstado(fechaValidez: string | null, avisoDias = 30): string {
  if (!fechaValidez) return "aviso"; // sin fecha -> el tecnico revisa
  const hoy = new Date();
  const val = new Date(fechaValidez);
  if (isNaN(val.getTime())) return "aviso";
  if (val < hoy) return "caducado";
  const diasRestantes = (val.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24);
  if (diasRestantes <= avisoDias) return "aviso";
  return "ok";
}

export interface CtxDoc {
  supa: Supa;
  system: BloqueSistema[];
  instanciaId: string;
  packId: string;
  driveId: string;            // KAPPA (kolven) o el que aplique
  rutaBasePartes: string[];   // p.ej. [obra, "CAE", "Clasificado"]
  claveToId: Map<string, { id: string; aviso: number; categoria: string | null; ambito: string | null }>;
}

export async function clasificarDocumento(
  ctx: CtxDoc,
  archivo: string,
  contenido: Uint8Array
): Promise<ResultadoDoc> {
  try {
    // 1) Extraer texto (nativo o OCR)
    const { texto } = await extraerTexto(contenido, archivo);
    if (!texto || texto.trim().length < 10) {
      return await guardarSinClasificar(ctx, archivo, contenido, "texto vacio o ilegible");
    }

    // 2) Clasificar con IA
    const resp = await llamarModelo(ctx.system, construirUser(archivo, texto));
    const cls = parseJsonTolerante<ClasificacionIA>(resp.texto);

    // 3) Resolver tipo contra catalogo
    const tipoInfo = cls.clave_doc_tipo ? ctx.claveToId.get(cls.clave_doc_tipo) : undefined;
    const revision = !tipoInfo || (cls.confidence ?? 0) < UMBRAL_REVISION;

    // 4) Resolver empresa / trabajador (idempotente via RPC)
    let empresaId: string | null = null;
    let trabajadorId: string | null = null;

    if (cls.empresa_cif) {
      empresaId = await ctx.supa.rpc<string>("caes_resolver_empresa", {
        p_instancia: ctx.instanciaId,
        p_cif: cls.empresa_cif,
        p_nombre: cls.empresa_nombre,
        p_rol: "subcontrata",
      });
    }
    if (cls.trabajador_dni && empresaId) {
      trabajadorId = await ctx.supa.rpc<string>("caes_resolver_trabajador", {
        p_instancia: ctx.instanciaId,
        p_empresa: empresaId,
        p_dni: cls.trabajador_dni,
        p_nombre: cls.trabajador_nombre,
        p_apellidos: cls.trabajador_apellidos,
      });
    }

    // 5) Archivar en SharePoint con jerarquia CAE (03 CSS/Empresa/Trabajadores|Maquinaria/...)
    const trabajadorNombre = (cls.trabajador_apellidos || cls.trabajador_nombre)
      ? `${(cls.trabajador_apellidos || "").trim()}${cls.trabajador_apellidos && cls.trabajador_nombre ? ", " : ""}${(cls.trabajador_nombre || "").trim()}`.trim()
      : null;
    const subRuta = rutaDentroCss({
      ambito: cls.ambito,
      categoria: tipoInfo?.categoria ?? null,
      claveDocTipo: cls.clave_doc_tipo,
      empresaNombre: cls.empresa_nombre,
      trabajadorNombre,
      matricula: cls.matricula_maquina,
    });
    const webUrl = await subirArchivo(
      ctx.driveId,
      [...ctx.rutaBasePartes, ...subRuta],
      archivo,
      contenido
    );

    // 6) Estado del documento
    const estado = revision ? "aviso" : calcularEstado(cls.fecha_validez, tipoInfo?.aviso ?? 30);

    // 7) Guardar prl_documento vía RPC (delete-before-insert; los indices unicos
    //    son parciales y PostgREST no puede on_conflict con ellos)
    await ctx.supa.rpc("caes_guardar_documento", {
      p_doc: {
        instancia_id: ctx.instanciaId,
        caes_pack_id: ctx.packId,
        doc_tipo_id: tipoInfo?.id ?? null,
        empresa_id: empresaId,
        trabajador_id: trabajadorId,
        estado,
        nombre_archivo: archivo,
        sharepoint_url: webUrl,
        fecha_emision: cls.fecha_emision,
        fecha_validez: cls.fecha_validez,
        mes_referencia: cls.mes_referencia,
        confidence: cls.confidence,
        revision_manual: revision,
        clasificado_ia: true,
        observaciones: (cls.alertas ?? []).join("; ") || null,
      },
    });

    return {
      archivo, ok: true,
      clave: cls.clave_doc_tipo,
      confidence: cls.confidence ?? 0,
      revision, estado, uso: resp.uso,
    };
  } catch (e: any) {
    return { archivo, ok: false, clave: null, confidence: 0, revision: true, estado: null, error: String(e?.message ?? e) };
  }
}

// Documento que no se pudo clasificar: se guarda igual, para revision manual
async function guardarSinClasificar(
  ctx: CtxDoc, archivo: string, contenido: Uint8Array, motivo: string
): Promise<ResultadoDoc> {
  try {
    const webUrl = await subirArchivo(ctx.driveId, [...ctx.rutaBasePartes, "_Sin clasificar"], archivo, contenido);
    await ctx.supa.rpc("caes_guardar_documento", { p_doc: {
      instancia_id: ctx.instanciaId,
      caes_pack_id: ctx.packId,
      doc_tipo_id: null,
      estado: "aviso",
      nombre_archivo: archivo,
      sharepoint_url: webUrl,
      confidence: 0,
      revision_manual: true,
      clasificado_ia: true,
      observaciones: `Sin clasificar: ${motivo}`,
    }});
  } catch { /* best-effort */ }
  return { archivo, ok: true, clave: null, confidence: 0, revision: true, estado: "aviso" };
}
