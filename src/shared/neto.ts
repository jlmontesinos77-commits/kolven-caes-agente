// neto.ts — fetch con timeout + reintentos con backoff.
// CLAVE: ningun fetch sin timeout. Un fetch colgado deja la instancia Durable
// en 'Running' eterna (bug raiz ya sufrido en el agente de licitaciones).

export async function fetchConTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  reintentos = 3
): Promise<Response> {
  let ultimoError: any;
  for (let intento = 0; intento < reintentos; intento++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(t);
      // Reintenta ante 429/5xx
      if (r.status === 429 || r.status >= 500) {
        ultimoError = new Error(`HTTP ${r.status}`);
        if (intento < reintentos - 1) {
          await sleep(backoff(intento));
          continue;
        }
      }
      return r;
    } catch (e: any) {
      clearTimeout(t);
      ultimoError = e;
      if (intento < reintentos - 1) {
        await sleep(backoff(intento));
        continue;
      }
    }
  }
  throw ultimoError ?? new Error(`fetch fallo tras ${reintentos} intentos: ${url}`);
}

function backoff(intento: number): number {
  return Math.min(1000 * Math.pow(2, intento), 8000) + Math.random() * 300;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
