// graph.ts — Microsoft Graph app-only para archivar el documento clasificado
// en SharePoint (Kolven: KAPPA drive). Conflicto -> replace.

import { CFG } from "./config";
import { fetchConTimeout } from "./neto";

let tokenCache: { token: string; exp: number } | null = null;

async function tokenAppOnly(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const url = `https://login.microsoftonline.com/${CFG.graphTenant()}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CFG.graphClient(),
    client_secret: CFG.graphSecret(),
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const r = await fetchConTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, 30000);
  if (!r.ok) throw new Error(`Graph token fallo ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

// Sanea nombre de carpeta MANTENIENDO tildes (coincide con el archivado existente)
export function sanitizarCarpeta(s: string): string {
  return (s || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/g, "")   // SharePoint rechaza nombres que terminan en punto o espacio
    .replace(/^[.\s]+/g, "")   // ni que empiezan por punto
    .slice(0, 120)
    .trim() || "sin_nombre";
}

export function saneFile(s: string): string {
  return (s || "documento")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// Asegura una ruta de carpetas dentro de un drive (crea las que falten)
async function ensureRuta(driveId: string, partes: string[]): Promise<string> {
  const token = await tokenAppOnly();
  let parentPath = "";
  for (const parte of partes) {
    const nombre = sanitizarCarpeta(parte);
    const urlBase = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:${parentPath}/${encodeURIComponent(nombre)}`;
    // ¿existe?
    const chk = await fetchConTimeout(urlBase, { headers: { Authorization: `Bearer ${token}` } }, 30000);
    if (!chk.ok) {
      // crear
      const parentSeg = parentPath === "" ? "root" : `root:${parentPath}:`;
      const crearUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/${parentSeg}/children`;
      const cr = await fetchConTimeout(crearUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: nombre, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
      }, 30000);
      // si otro proceso la creo a la vez, ignora el 409
      if (!cr.ok && cr.status !== 409) throw new Error(`crear carpeta ${nombre} fallo ${cr.status}`);
    }
    parentPath = `${parentPath}/${nombre}`;
  }
  return parentPath;
}

// Sube un fichero (replace) a driveId en la ruta indicada; devuelve webUrl
export async function subirArchivo(
  driveId: string,
  rutaPartes: string[],
  nombreArchivo: string,
  contenido: Uint8Array
): Promise<string> {
  const token = await tokenAppOnly();
  const carpeta = await ensureRuta(driveId, rutaPartes);
  const fileName = saneFile(nombreArchivo);
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:${carpeta}/${encodeURIComponent(fileName)}:/content?@microsoft.graph.conflictBehavior=replace`;
  const r = await fetchConTimeout(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: contenido as any,
  }, 90000);
  if (!r.ok) throw new Error(`subir ${fileName} fallo ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  return j.webUrl ?? "";
}
