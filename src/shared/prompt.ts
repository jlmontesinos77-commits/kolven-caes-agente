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
- CIF empresa: formato español (letra+8 digitos o similar). Normaliza sin espacios ni guiones.
- DNI/NIE trabajador: 8 digitos+letra (DNI) o X/Y/Z+7 digitos+letra (NIE).
- Fechas: formato ISO YYYY-MM-DD. fecha_emision = cuando se emite/firma. fecha_validez = hasta cuando vale; si el documento no la indica pero el TIPO tiene caducidad conocida (p.ej. reconocimiento medico = 1 año), calcula fecha_validez = fecha_emision + caducidad e indicalo en 'alertas'.
- Documentos mensuales (TGSS, RNT/RLC): rellena mes_referencia = primer dia del mes al que corresponde (YYYY-MM-01).
- confidence: 0.0 a 1.0. Baja (<0.7) si el texto es ambiguo, esta incompleto o la clasificacion es dudosa.

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
