// prompt.ts — prompt de clasificacion de documentos PRL/CAES.
// El catalogo de tipos se inyecta cacheado (cache_control) porque es estable
// dentro de un pack: mismo system para los N documentos del lote.

import { BloqueSistema } from "./anthropic";

export interface DocTipoCatalogo {
  clave: string;
  ambito: string;      // empresa | trabajador | maquinaria
  categoria: string;
  nombre: string;
  aviso_dias_antes: number;
}

const INSTRUCCIONES = `Eres un clasificador experto de documentacion de Prevencion de Riesgos Laborales (PRL) y Coordinacion de Actividades Empresariales (CAE) para acceso a obra en España.

Recibes UN documento. Puede llegarte de dos formas: (a) como IMAGEN/PDF ADJUNTO — entonces LEELO DIRECTAMENTE del documento, que puede ser una foto de movil o un escaneo de mala calidad, estar torcido o tener sellos y firmas; o (b) como TEXTO EXTRAIDO. Si viene adjunto el documento, prima lo que ves en el; el texto (si lo hay) es solo una ayuda. Tu tarea: identificar QUE documento es (contra el catalogo), A QUIEN pertenece (empresa por CIF, trabajador por DNI/NIE, o maquina por matricula) y sus FECHAS relevantes.

Si el archivo contiene VARIOS documentos distintos (p. ej. dos diplomas en un mismo PDF), clasifica el mas representativo y añade la alerta "PDF con varios documentos".

NO validas la correccion legal del documento. Solo identificas, asignas y fechas. La decision final es humana.

REGLAS:
- Clave del tipo: elige la 'clave' del catalogo que mejor encaje. Si NINGUNA encaja con seguridad razonable, devuelve clave_doc_tipo=null (se marcara para revision manual).
- CIF empresa: formato español (letra+8 digitos o similar). Normaliza sin espacios ni guiones. NUNCA inventes un CIF: si no lo ves claro en el documento, pon empresa_cif=null. Es MEJOR null que un CIF dudoso (un CIF mal leido crea empresas duplicadas). El NOMBRE de la empresa es mas fiable que el CIF: extraelo siempre que puedas. Si el CIF esta borroso, tachado o poco legible, ponlo a null y añade una alerta "CIF ilegible" — el sistema lo completara desde su base de datos.
- EMPRESA TITULAR vs PROVEEDOR DE SERVICIO (regla critica para no duplicar empresas): la 'empresa' es la EMPRESA CONTRATISTA/SUBCONTRATISTA a la que pertenece el TRABAJADOR o el documento (la que ejecuta la obra). NO confundas con el PROVEEDOR EXTERNO que EMITE el documento: los Servicios de Prevencion Ajenos (SPA), mutuas, centros medicos, academias de formacion o gestorias aparecen en el membrete/logo pero NO son la empresa titular. Ejemplos de proveedores que NUNCA debes poner como empresa_nombre salvo que el documento sea suyo propio: nombres con "PREVENCION", "SERVICIO DE PREVENCION", "SPA", "DICONSAL", "IGS", "SOLUCIONES ... PREVENCION", "FREMAP", "ASEPEYO", "QUIRON", academias/centros de formacion. Para saber la empresa titular, busca a que empresa esta ADSCRITO el trabajador (suele figurar como "empresa", "razon social del cliente", "empresa contratante") o el titular del contrato/adhesion al PSS. Si el documento SOLO muestra el proveedor y no la empresa titular, pon empresa_nombre=null (mejor null que una empresa espuria) y añade alerta "Empresa titular no visible".
- REGLA DEL CIF AUSENTE: un documento cuya empresa titular NO aparece con su CIF suele ser un documento de proveedor (diploma de curso, reconocimiento medico, certificado de formacion): el nombre que ves es de la academia/mutua, no de la empresa del trabajador. En diplomas y reconocimientos medicos, por defecto empresa_nombre=null salvo que el propio documento indique explicitamente la empresa contratante del alumno/paciente con su razon social.
- CONTRATISTA vs SUBCONTRATA (para el rol, no inventes empresas): la empresa que figura en la COMUNICACION DE APERTURA DE CENTRO DE TRABAJO es la CONTRATISTA PRINCIPAL. Las que figuran en ADHESIONES AL PSS posteriores suelen ser SUBCONTRATAS. Esto no cambia empresa_nombre (sigue siendo la empresa real del documento), solo ayuda a entender la jerarquia; no crees empresas nuevas por esto.
- OCR de nombres de empresa: si el nombre parece un error de lectura (letras cambiadas, palabras raras como "NUNENA" por "INNOVA"), prefiere la forma mas frecuente/plausible o pon lo que leas con confidence baja; el sistema consolida variantes, pero un nombre muy corrupto crea ruido.
- DNI/NIE trabajador: 8 digitos+letra (DNI) o X/Y/Z+7 digitos+letra (NIE).
- Fechas: formato ISO YYYY-MM-DD. fecha_emision = cuando se emite/firma. fecha_validez = hasta cuando vale; si el documento no la indica pero el TIPO tiene caducidad conocida, CALCULA fecha_validez = fecha_emision + caducidad e indicalo en 'alertas'. NO dejes fecha_validez en null cuando el tipo tenga caducidad conocida.
- CADUCIDADES POR TIPO (usa estas salvo que el documento indique otra fecha explicita):
    * DNI/NIE/carne/pasaporte: usa la fecha de caducidad IMPRESA en el documento.
    * Reconocimiento medico / aptitud: 12 meses. Entrega de EPIs: 12 meses. Autorizacion de maquinaria: 12 meses.
    * Formacion PRL segun el curso: aula permanente TPC (inicial 8h o de oficio 20h), formacion por oficio TPC, curso basico PRL 30h/50h -> INDEFINIDA (fecha_validez=null, y alerta "Formacion indefinida"). Trabajos en altura, PEMP/plataformas elevadoras, aparatos elevadores, grua torre/movil, carretillas, cubiertas, trabajos verticales -> 3 años. Espacios confinados -> 1 año. Primeros auxilios -> 2 años. Si no distingues el curso -> 3 años.
    * Contrato/alta, informacion de obra/acogida, nombramiento recurso preventivo -> sin caducidad fija (null).
    * Empresa: TC/RNT -> 1 mes; AEAT -> 6 meses; RC poliza/recibo -> 1 año; REA -> 3 años; SPA -> 1 año; evaluacion de riesgos -> 1 año; mutua -> no caduca (null).
    * Maquina: ITV/OCA/RC -> 1 año.
- Documentos mensuales (TGSS, RNT/RLC): rellena mes_referencia = primer dia del mes al que corresponde (YYYY-MM-01).
- confidence: 0.0 a 1.0. Baja (<0.7) si el texto es ambiguo, esta incompleto o la clasificacion es dudosa.
- alertas: cada alerta es CORTA y TELEGRAFICA (máximo ~8 palabras), como una etiqueta de aviso, NO una frase larga ni un párrafo explicativo. Ejemplos correctos: "CIF ilegible", "Sin fecha de caducidad", "Máquinas sin matrícula", "DNI no visible", "Documento firmado 28/10/2024". Máximo 4 alertas, solo lo esencial que un técnico deba revisar. NUNCA vuelques todo tu razonamiento aquí: solo avisos accionables y breves.

Responde SOLO con un objeto JSON, sin texto alrededor, con esta forma exacta:
{
  "clave_doc_tipo": "ss.empresa.poliza_rc" | null,
  "ambito": "empresa" | "trabajador" | "maquinaria" | null,
  "empresa_cif": "B12345678" | null,
  "empresa_nombre": "..." | null,
  "trabajador_dni": "12345678Z" | null,
  "trabajador_nombre": "..." | null,
  "trabajador_apellidos": "..." | null,
  "matricula_maquina": "..." | null,
  "fecha_emision": "YYYY-MM-DD" | null,
  "fecha_validez": "YYYY-MM-DD" | null,
  "mes_referencia": "YYYY-MM-01" | null,
  "confidence": 0.0,
  "alertas": ["..."]
}`;

export function construirSystem(catalogo: DocTipoCatalogo[]): BloqueSistema[] {
  const catStr = catalogo
    .map((c) => `- ${c.clave} [${c.ambito}] ${c.nombre}`)
    .join("\n");

  return [
    { type: "text", text: INSTRUCCIONES },
    {
      type: "text",
      text: `CATALOGO DE TIPOS DE DOCUMENTO DISPONIBLES:\n${catStr || "(catalogo vacio: devuelve clave_doc_tipo=null siempre)"}`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

// --- EXTRACCIÓN DE ROSTER (censo de trabajadores) ---
// Para documentos tipo ITA / Relación de trabajadores / TC2 / RNT que LISTAN a
// varios trabajadores de una empresa. En vez de clasificar un solo titular,
// extraemos la lista COMPLETA para dar de alta a todo el censo de una vez. Así,
// cuando luego llegan diplomas/EPIs sin nombre de empresa, su DNI ya casa con un
// trabajador existente (en vez de quedar "sin asignar").
const INSTRUCCIONES_ROSTER = `Eres un extractor de censos de trabajadores en documentacion laboral española (ITA/relacion de trabajadores adscritos a una obra, TC2, RNT/RLC, listados de personal).

Recibes UN documento (imagen/PDF adjunto o texto extraido) que LISTA varios trabajadores. Tu unica tarea: devolver la lista COMPLETA de personas fisicas (trabajadores) que aparecen, con su identificador y nombre.

REGLAS:
- Incluye a TODOS los trabajadores del listado, sin omitir filas. Si hay muchas paginas o filas, extraelas todas.
- DNI/NIE: 8 digitos+letra (DNI) o X/Y/Z+7 digitos+letra (NIE). Normaliza sin espacios ni guiones. Si una fila no tiene DNI/NIE legible, incluyela igual con dni=null (usaremos el nombre).
- Separa apellidos y nombre cuando puedas ("APELLIDO1 APELLIDO2, NOMBRE"). Si no puedes separarlos con seguridad, pon todo en 'apellidos' y nombre=null.
- NO incluyas a la empresa, ni firmantes, ni tecnicos de prevencion, ni representantes que no sean trabajadores del censo. Solo el personal listado.
- Si el documento NO es realmente un listado de varios trabajadores (es de un solo titular o no lista personas), devuelve trabajadores=[].
- empresa_cif / empresa_nombre: el de la empresa TITULAR del censo (la contratista/subcontrata cuyos trabajadores se listan), si aparece con claridad; si no, null.

Responde SOLO con un objeto JSON, sin texto alrededor:
{
  "empresa_cif": "B12345678" | null,
  "empresa_nombre": "..." | null,
  "trabajadores": [
    { "dni": "12345678Z" | null, "nombre": "..." | null, "apellidos": "..." | null }
  ]
}`;

export function construirSystemRoster(): BloqueSistema[] {
  return [{ type: "text", text: INSTRUCCIONES_ROSTER }];
}

export function construirUserRoster(nombreArchivo: string, texto: string, modoVision = false): string {
  if (modoVision) {
    const hint = texto && texto.trim().length > 0
      ? `\n\nTEXTO EXTRAIDO (solo AYUDA; manda el documento adjunto):\n${texto.length > 12000 ? texto.slice(0, 12000) + "\n[...]" : texto}`
      : "";
    return `NOMBRE DEL ARCHIVO: ${nombreArchivo}\n\nEl documento va ADJUNTO: leelo directamente y extrae TODOS los trabajadores del listado.${hint}`;
  }
  const recorte = texto.length > 16000 ? texto.slice(0, 16000) + "\n[...texto truncado...]" : texto;
  return `NOMBRE DEL ARCHIVO: ${nombreArchivo}\n\nTEXTO EXTRAIDO:\n${recorte}`;
}

export function construirUser(nombreArchivo: string, texto: string, modoVision = false): string {
  if (modoVision) {
    const hint = texto && texto.trim().length > 0
      ? `\n\nTEXTO EXTRAIDO (solo AYUDA; manda el documento adjunto):\n${texto.length > 8000 ? texto.slice(0, 8000) + "\n[...]" : texto}`
      : "";
    return `NOMBRE DEL ARCHIVO: ${nombreArchivo}\n\nEl documento va ADJUNTO como imagen/PDF: leelo directamente.${hint}`;
  }
  const recorte = texto.length > 12000 ? texto.slice(0, 12000) + "\n[...texto truncado...]" : texto;
  return `NOMBRE DEL ARCHIVO: ${nombreArchivo}\n\nTEXTO EXTRAIDO:\n${recorte}`;
}
