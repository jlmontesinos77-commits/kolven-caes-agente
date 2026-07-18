// blob.ts — acceso al staging de ZIP en Azure Blob.
// - genera SAS de subida (para el frontend, key nunca sale de Azure)
// - descarga el ZIP a memoria/stream para el orchestrator

import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
} from "@azure/storage-blob";
import { CFG } from "./config";

function parseConn(conn: string): { account: string; key: string } {
  const account = /AccountName=([^;]+)/.exec(conn)?.[1] ?? "";
  const key = /AccountKey=([^;]+)/.exec(conn)?.[1] ?? "";
  return { account, key };
}

// SAS de SUBIDA: permiso de escritura/creacion, caduca en minutos
export function generarSasSubida(blobPath: string, minutos = 60): { url: string; blobPath: string } {
  const conn = CFG.blobConn();
  const container = CFG.blobContainer();
  const { account, key } = parseConn(conn);
  const cred = new StorageSharedKeyCredential(account, key);

  const starts = new Date(Date.now() - 2 * 60 * 1000);
  const expires = new Date(Date.now() + minutos * 60 * 1000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: container,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("cw"), // create + write
      startsOn: starts,
      expiresOn: expires,
      protocol: SASProtocol.Https,
    },
    cred
  ).toString();

  const url = `https://${account}.blob.core.windows.net/${container}/${blobPath}?${sas}`;
  return { url, blobPath };
}

// Descarga el ZIP entero a un Buffer (streaming interno de Azure, sin egress)
export async function descargarZip(blobPath: string): Promise<Buffer> {
  const svc = BlobServiceClient.fromConnectionString(CFG.blobConn());
  const container = svc.getContainerClient(CFG.blobContainer());
  const blob = container.getBlobClient(blobPath);
  return await blob.downloadToBuffer();
}

// Descarga un blob individual a Buffer
export async function descargarBlob(blobPath: string): Promise<Buffer> {
  const svc = BlobServiceClient.fromConnectionString(CFG.blobConn());
  const container = svc.getContainerClient(CFG.blobContainer());
  return await container.getBlobClient(blobPath).downloadToBuffer();
}

// Lista los blobs bajo un prefijo (p.ej. todos los ficheros de un pack)
export async function listarPorPrefijo(prefijo: string): Promise<{ name: string; size: number }[]> {
  const svc = BlobServiceClient.fromConnectionString(CFG.blobConn());
  const container = svc.getContainerClient(CFG.blobContainer());
  const out: { name: string; size: number }[] = [];
  for await (const b of container.listBlobsFlat({ prefix: prefijo })) {
    out.push({ name: b.name, size: b.properties.contentLength ?? 0 });
  }
  return out;
}

export async function borrarPrefijo(prefijo: string): Promise<void> {
  try {
    const svc = BlobServiceClient.fromConnectionString(CFG.blobConn());
    const container = svc.getContainerClient(CFG.blobContainer());
    for await (const b of container.listBlobsFlat({ prefix: prefijo })) {
      await container.getBlobClient(b.name).deleteIfExists();
    }
  } catch {
    // best-effort; el lifecycle lo purga igual
  }
}
