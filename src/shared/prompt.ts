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

Recibes el TEXTO EXTRAIDO de un unico documento. Tu tarea: identificar QUE documento es (contra el catalogo), A QUIEN pertenece (empresa por CIF, trabajador por DNI/NIE, o maquina por matricula) y sus FECHAS relevantes.

NO validas la correccion legal del documento. Solo identificas, asignas y fechas. La decision final es humana.

REGLAS:
- Clave del tipo: elige la 'clave' del catalogo que mejor encaje. Si NINGUNA encaja con seguridad razonable, devuelve clave_doc_tipo=null (se marcara para revision manual).
- CIF empresa: formato español (letra+8 digitos o similar). Normaliza sin espacios ni guiones. NUNCA inventes un CIF: si no lo ves claro en el documento, pon empresa_cif=null. Es MEJOR null que un CIF dudoso (un CIF mal leido crea empresas duplicadas). El NOMBRE de la empresa es mas fiable que el CIF: extraelo siempre que puedas. Si el CIF esta borroso, tachado o poco legible, ponlo a null y añade una alerta "CIF ilegible" — el sistema lo completara desde su base de datos.
- EMPRESA TITULAR vs PROVEEDOR DE SERVICIO (regla critica para no duplicar empresas): la 'empresa' es la EMPRESA CONTRATISTA/SUBCONTRATISTA a la que pertenece el TRABAJADOR o el documento (la que ejecuta la obra). NO confundas con el PROVEEDOR EXTERNO que EMITE el documento: los Servicios de Prevencion Ajenos (SPA), mutuas, centros medicos, academias de formacion o gestorias aparecen en el membrete/logo pero NO son la empresa titular. Ejemplos de proveedores que NUNCA debes poner como empresa_nombre salvo que el documento sea suyo propio: nombres con "PREVENCION", "SERVICIO DE PREVENCION", "SPA", "DICONSAL", "IGS", "SOLUCIONES ... PREVENCION", "FREMAP", "ASEPEYO", "QUIRON", academias/centros de formacion. Para saber la empresa titular, busca a que empresa esta ADSCRITO el trabajador (suele figurar como "empresa", "razon social del cliente", "empresa contratante") o el titular del contrato/adhesion al PSS. Si el documento SOLO muestra el proveedor y no la empresa titular, pon empresa_nombre=null (mejor null que una empresa espuria) y añade alerta "Empresa titular no visible".
- REGLA DEL CIF AUSENTE: un documento cuya empresa titular NO aparece con su CIF suele ser un documento de proveedor (diploma de curso, reconocimiento medico, certificado de formacion): el nombre que ves es de la academia/mutua, no de la empresa del trabajador. En diplomas y reconocimientos medicos, por defecto empresa_nombre=null salvo que el propio documento indique explicitamente la empresa contratante del alumno/paciente con su razon social.
- CONTRATISTA vs SUBCONTRATA (para el rol, no inventes empresas): la empresa que figura en la COMUNICACION DE APERTURA DE CENTRO DE TRABAJO es la CONTRATISTA PRINCIPAL. Las que figuran en ADHESIONES AL PSS posteriores suelen ser SUBCONTRATAS. Esto no cambia empresa_nombre (sigue siendo la empresa real del documento), solo ayuda a entender la jerarquia; no crees empresas nuevas por esto.
- OCR de nombres de empresa: si el nombre parece un error de lectura (letras cambiadas, palabras raras como "NUNENA" por "INNOVA"), prefiere la forma mas frecuente/plausible o pon lo que leas con confidence baja; el sistema consolida variantes, pero un nombre muy corrupto crea ruido.
- DNI/NIE trabajador: 8 digitos+letra (DNI) o X/Y/Z+7 digitos+letra (NIE).
- Fechas: formato ISO YYYY-MM-DD. fecha_emision = cuando se emite/firma. fecha_validez = hasta cuando vale; si el documento no la indica pero el TIPO tiene caducidad conocida (p.ej. reconocimiento medico = 1 año), calcula fecha_validez = fecha_emision + caducidad e indicalo en 'alertas'.
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

export function construirUser(nombreArchivo: string, texto: string): string {
  const recorte = texto.length > 12000 ? texto.slice(0, 12000) + "\n[...texto truncado...]" : texto;
  return `NOMBRE DEL ARCHIVO: ${nombreArchivo}\n\nTEXTO EXTRAIDO:\n${recorte}`;
}
