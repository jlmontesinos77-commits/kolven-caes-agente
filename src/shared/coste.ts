// coste.ts — registro del coste de IA de CAES, homogéneo con el Redactor.
// Una clasificación = una llamada a Claude = una fila de coste.
//
// Multi-tenant: CAES puede correr sobre Kolven Core o sobre el SaaS.
//  - origen "kolven" -> escribe en coste_ia (Core), origen='caes'.
//  - origen "saas"   -> escribe en uso_medicion (SaaS), operacion='clasificacion_prl'.
// Los precios EUR son EXACTAMENTE los del Redactor (src/lib/claude.ts) para no
// divergir. Se añade el coste USD (moneda real de facturación de Anthropic) para
// poder reconciliar contra la Usage & Cost API en el dashboard 04.

import { Supa } from "./supa";
import { TenantCfg } from "./config";
import { UsoTokens } from "./anthropic";

// Precios claude-sonnet-4-6 en €/Mtok (idénticos al Redactor).
const PRICE_INPUT_EUR = 2.7;
const PRICE_OUTPUT_EUR = 13.5;
const PRICE_CACHE_READ_EUR = PRICE_INPUT_EUR * 0.1;
const PRICE_CACHE_WRITE_EUR = PRICE_INPUT_EUR * 1.25;

// Precios en $/Mtok (tarifa pública Anthropic Sonnet). USD = lo que factura.
const PRICE_INPUT_USD = 3.0;
const PRICE_OUTPUT_USD = 15.0;
const PRICE_CACHE_READ_USD = PRICE_INPUT_USD * 0.1;
const PRICE_CACHE_WRITE_USD = PRICE_INPUT_USD * 1.25;

export function costeEur(u: UsoTokens): number {
  return (
    u.input * PRICE_INPUT_EUR +
    u.output * PRICE_OUTPUT_EUR +
    u.cacheRead * PRICE_CACHE_READ_EUR +
    u.cacheCreate * PRICE_CACHE_WRITE_EUR
  ) / 1_000_000;
}

export function costeUsd(u: UsoTokens): number {
  return (
    u.input * PRICE_INPUT_USD +
    u.output * PRICE_OUTPUT_USD +
    u.cacheRead * PRICE_CACHE_READ_USD +
    u.cacheCreate * PRICE_CACHE_WRITE_USD
  ) / 1_000_000;
}

export interface RegistroCoste {
  modelo: string;
  uso: UsoTokens;
  concepto: string;              // p.ej. 'Clasificación PRL/CAE · nomina.pdf'
  instanciaId?: string | null;
  packId?: string | null;
  orgId?: string | null;         // tenant consumidor (SaaS). null = uso interno Kolven.
  servicioId?: string | null;    // solo SaaS (uso_medicion.servicio_id)
  meta?: Record<string, any> | null;
}

// Registra el coste en la tabla que corresponde al tenant. Nunca rompe el flujo:
// un fallo al registrar no debe tumbar la clasificación de un documento.
export async function registrarCosteCaes(
  supa: Supa,
  cfg: TenantCfg,
  r: RegistroCoste
): Promise<void> {
  try {
    const eur = costeEur(r.uso);
    const usd = costeUsd(r.uso);

    if (cfg.origen === "saas") {
      await supa.insert("uso_medicion", {
        org_id: r.orgId ?? null,
        servicio_id: r.servicioId ?? null,
        operacion: "clasificacion_prl",
        modelo: r.modelo,
        modelo_version: r.modelo,
        tokens_in: r.uso.input,
        tokens_out: r.uso.output,
        cache_read_tokens: r.uso.cacheRead,
        cache_creation_tokens: r.uso.cacheCreate,
        coste_eur: eur,
        coste_usd: usd,
        meta: { ...(r.meta ?? {}), instancia_id: r.instanciaId, pack_id: r.packId },
      });
    } else {
      await supa.insert("coste_ia", {
        origen: "caes",
        fase: "clasificacion",
        org_id: r.orgId ?? null,
        modelo: r.modelo,
        input_tokens: r.uso.input,
        output_tokens: r.uso.output,
        cache_read_tokens: r.uso.cacheRead,
        cache_creation_tokens: r.uso.cacheCreate,
        coste_eur: eur,
        coste_usd: usd,
        concepto: r.concepto,
        meta: { ...(r.meta ?? {}), instancia_id: r.instanciaId, pack_id: r.packId },
      });
    }
  } catch (e: any) {
    // No crítico: se registra el aviso y se continúa.
    console.warn(`[registrarCosteCaes] no se pudo registrar el coste: ${e?.message ?? e}`);
  }
}
