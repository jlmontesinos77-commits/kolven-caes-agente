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
  doc_id?: string;
  sharepoint_url?: string;
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
  // MODELO CONTROLADO:
  // - Si empresaFijada/trabajadorFijado vienen informados (subida contextual desde
  //   el panel, "subir dentro de ROURE"), el clasificador NO resuelve empresa: usa
  //   el titular que le da el usuario. Cero ambiguedad de OCR de nombres.
  // - Si no vienen (ZIP masivo), el clasificador CASA contra empresas/trabajadores
  //   existentes por CIF/DNI. NUNCA crea empresas. Lo que no casa -> sin asignar.
  empresaFijada?: string | null;
  trabajadorFijado?: string | null;
  maquinariaFijada?: string | null;
}

export async function clasificarDocumento(
  ctx: CtxDoc,
  archivo: string,
  contenido: Uint8Array,
  pista?: string | null
): Promise<ResultadoDoc> {
  try {
    // 1) Extraer texto (nativo o OCR)
    const { texto } = await extraerTexto(contenido, archivo);
    if (!texto || texto.trim().length < 10) {
      return await guardarSinClasificar(ctx, archivo, contenido, "texto vacio o ilegible");
    }

    // 2) Clasificar con IA. La pista (nombre de zips contenedores) ayuda a la IA
    //    a inferir la empresa, pero NO forma parte del nombre fisico del archivo.
    const nombreParaIA = pista ? `${archivo} [origen: ${pista}]` : archivo;
    const resp = await llamarModelo(ctx.system, construirUser(nombreParaIA, texto));
    const cls = parseJsonTolerante<ClasificacionIA>(resp.texto);

    // 3) Resolver tipo contra catalogo
    const tipoInfo = cls.clave_doc_tipo ? ctx.claveToId.get(cls.clave_doc_tipo) : undefined;
    const revision = !tipoInfo || (cls.confidence ?? 0) < UMBRAL_REVISION;

    // 4) Determinar titular del documento segun el MODELO CONTROLADO.
    let empresaId: string | null = null;
    let trabajadorId: string | null = null;
    let maquinariaId: string | null = null;
    let empresaNombreCanonico: string | null = null;
    let trabajadorNombreCanonico: string | null = null;
    let sinAsignar = false;
    let pistaSinAsignar: string | null = null;

    const hayTitularFijado = !!(ctx.empresaFijada || ctx.trabajadorFijado || ctx.maquinariaFijada);

    if (hayTitularFijado) {
      // --- MODO A: titular FIJADO por el usuario (subida contextual) ---
      // No se resuelve nada: el usuario manda. Solo se clasifica el tipo (ya hecho).
      trabajadorId = ctx.trabajadorFijado ?? null;
      maquinariaId = ctx.maquinariaFijada ?? null;
      if (trabajadorId) {
        // heredar empresa del trabajador para coherencia de arbol
        const t = await ctx.supa.select<any>("prl_trabajador", `id=eq.${trabajadorId}&select=empresa_id`);
        empresaId = t[0]?.empresa_id ?? null;
      } else {
        empresaId = ctx.empresaFijada ?? null;
      }
    } else {
      // --- MODO B: ZIP masivo. CASAR contra existentes. NUNCA crear empresa. ---
      // Filtro de proveedores (mutuas/SPA/academias no son empresa titular).
      const nombreEmpresaIA = (cls.empresa_nombre || "").trim();
      const esProveedor = /\b(PREVENCION|PREVENCIÓN|SERVICIO DE PREVENCION|SPA|MUTUA|FREMAP|ASEPEYO|QUIRON|QUIRÓN|UNIÓN DE MUTUAS|UMIVALE|CENTRO M[EÉ]DICO|CENTRO DE FORMACION|CENTRO DE FORMACIÓN|ACADEMIA|FORMACION|FORMACIÓN|DICONSAL|IGS|SALUD LABORAL|GESTIONES PREVENTIVAS|VIGILANCIA DE LA SALUD)\b/i.test(nombreEmpresaIA);
      const cifFiable = esProveedor ? null : (cls.empresa_cif || null);

      // Casar EMPRESA contra existentes (solo match, sin crear).
      empresaId = await ctx.supa.rpc<string>("caes_casar_empresa", {
        p_instancia: ctx.instanciaId,
        p_cif: cifFiable,
        p_nombre: esProveedor ? null : (nombreEmpresaIA || null),
      });

      // Casar/crear TRABAJADOR por DNI (el DNI es fiable). Solo si su empresa caso.
      if (cls.trabajador_dni && empresaId) {
        trabajadorId = await ctx.supa.rpc<string>("caes_resolver_trabajador", {
          p_instancia: ctx.instanciaId,
          p_empresa: empresaId,
          p_dni: cls.trabajador_dni,
          p_nombre: cls.trabajador_nombre,
          p_apellidos: cls.trabajador_apellidos,
        });
      } else if (cls.trabajador_dni && !empresaId) {
        // Hay trabajador pero su empresa no casa -> intentar casar por DNI a un
        // trabajador YA existente (creado por otro doc). Si existe, cuelga de el.
        trabajadorId = await ctx.supa.rpc<string>("caes_casar_trabajador", {
          p_instancia: ctx.instanciaId,
          p_dni: cls.trabajador_dni,
        });
        if (trabajadorId) {
          const t = await ctx.supa.select<any>("prl_trabajador", `id=eq.${trabajadorId}&select=empresa_id`);
          empresaId = t[0]?.empresa_id ?? null;
        }
      }

      // Si NADA caso -> SIN ASIGNAR. No inventamos empresa. Dejamos pista.
      if (!empresaId && !trabajadorId && !maquinariaId) {
        sinAsignar = true;
        const partes = [nombreEmpresaIA, cls.empresa_cif, cls.trabajador_dni].filter(Boolean);
        pistaSinAsignar = partes.length ? `Leido: ${partes.join(" / ")}` : "Sin datos de titular";
      }
    }

    // Leer los nombres CANONICOS de la empresa/trabajador resueltos, para que la
    // carpeta de SharePoint use el nombre consolidado (no el crudo de la IA).
    // Esto evita 34 carpetas para la misma empresa escrita de 34 formas.
    if (empresaId) {
      const filas = await ctx.supa.select<any>("prl_empresa", `id=eq.${empresaId}&select=nombre`);
      empresaNombreCanonico = filas[0]?.nombre ?? null;
    }
    if (trabajadorId) {
      const filas = await ctx.supa.select<any>("prl_trabajador", `id=eq.${trabajadorId}&select=nombre,apellidos`);
      const t = filas[0];
      if (t) {
        trabajadorNombreCanonico = `${(t.apellidos || "").trim()}${t.apellidos && t.nombre ? ", " : ""}${(t.nombre || "").trim()}`.trim() || null;
      }
    }

    // 5) Archivar en SharePoint. Si el doc quedo SIN ASIGNAR, va a una bandeja
    //    fisica "_SIN ASIGNAR" (no se crea carpeta de empresa espuria).
    let subRuta: string[];
    if (sinAsignar) {
      subRuta = ["_SIN ASIGNAR"];
    } else {
      const trabajadorNombre = trabajadorNombreCanonico
        ?? ((cls.trabajador_apellidos || cls.trabajador_nombre)
          ? `${(cls.trabajador_apellidos || "").trim()}${cls.trabajador_apellidos && cls.trabajador_nombre ? ", " : ""}${(cls.trabajador_nombre || "").trim()}`.trim()
          : null);
      subRuta = rutaDentroCss({
        ambito: cls.ambito,
        categoria: tipoInfo?.categoria ?? null,
        claveDocTipo: cls.clave_doc_tipo,
        empresaNombre: empresaNombreCanonico ?? null,
        trabajadorNombre,
        matricula: cls.matricula_maquina,
      });
    }
    const webUrl = await subirArchivo(
      ctx.driveId,
      [...ctx.rutaBasePartes, ...subRuta],
      archivo,
      contenido
    );

    // 6) Estado del documento
    const estado = revision || sinAsignar ? "aviso" : calcularEstado(cls.fecha_validez, tipoInfo?.aviso ?? 30);

    // 7) Guardar prl_documento. Si sinAsignar, los 3 FK van null y la pista del
    //    titular leido se guarda en observaciones para resolver desde la bandeja.
    const obsBase = (cls.alertas ?? []).join("; ");
    const observaciones = sinAsignar
      ? [pistaSinAsignar, obsBase].filter(Boolean).join(" | ")
      : (obsBase || null);
    const docId = await ctx.supa.rpc<string>("caes_guardar_documento", {
      p_doc: {
        instancia_id: ctx.instanciaId,
        caes_pack_id: ctx.packId,
        doc_tipo_id: tipoInfo?.id ?? null,
        empresa_id: empresaId,
        trabajador_id: trabajadorId,
        maquinaria_id: maquinariaId,
        estado,
        nombre_archivo: archivo,
        sharepoint_url: webUrl,
        fecha_emision: cls.fecha_emision,
        fecha_validez: cls.fecha_validez,
        mes_referencia: cls.mes_referencia,
        confidence: cls.confidence,
        revision_manual: revision || sinAsignar,
        clasificado_ia: true,
        observaciones,
      },
    });
    if (!docId) {
      return { archivo, ok: false, clave: cls.clave_doc_tipo, confidence: cls.confidence ?? 0,
               revision: true, estado, error: "guardado no devolvio id" };
    }

    return {
      archivo, ok: true, doc_id: docId, sharepoint_url: webUrl,
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
    const docId = await ctx.supa.rpc<string>("caes_guardar_documento", { p_doc: {
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
    return { archivo, ok: !!docId, doc_id: docId, sharepoint_url: webUrl,
             clave: null, confidence: 0, revision: true, estado: "aviso",
             error: docId ? undefined : "guardado sin clasificar no devolvio id" };
  } catch (e: any) {
    return { archivo, ok: false, clave: null, confidence: 0, revision: true, estado: "aviso",
             error: `sin clasificar y sin guardar: ${String(e?.message ?? e)}` };
  }
}
