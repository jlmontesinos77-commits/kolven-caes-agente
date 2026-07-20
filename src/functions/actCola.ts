// actCola.ts — activities de gestion de la cola (reclamar / finalizar).
import * as df from "durable-functions";
import { InvocationContext } from "@azure/functions";
import { randomUUID } from "crypto";
import { Supa } from "../shared/supa";
import { tenantConfig } from "../shared/config";

// Reclama un trabajo clasificar_pack de la cola del tenant
df.app.activity("reclamarTrabajo", {
  handler: async (input: { origen: string }, _ctx: InvocationContext) => {
    const supa = new Supa(tenantConfig(input.origen));
    const worker = randomUUID();
    const row = await supa.rpc<any>("agente_reclamar_trabajo", {
      p_worker: worker,
      p_operacion: "clasificar_pack",
    });
    if (!row || (Array.isArray(row) && row.length === 0)) return null;
    const trabajo = Array.isArray(row) ? row[0] : row;
    if (!trabajo?.id) return null;
    return { ...trabajo, claim_token: worker };
  },
});

// Cierra el trabajo y actualiza el estado del pack
df.app.activity("finalizarTrabajo", {
  handler: async (input: any, _ctx: InvocationContext) => {
    const supa = new Supa(tenantConfig(input.origen));

    // 1) cerrar trabajo en la cola
    // p_permanente: fallo determinista (ZIP inexistente/corrupto en preparacion)
    // -> no reintentar, cerrar a 'error' a la primera. Fallos transitorios omiten
    // el flag y conservan el reintento con backoff.
    await supa.rpc("agente_completar_trabajo", {
      p_trabajo: input.trabajoId,
      p_worker: input.worker,
      p_ok: input.ok,
      p_salida: input.salida ?? null,
      p_error: input.error ?? null,
      p_permanente: input.permanente ?? false,
    });

    // 2) actualizar progreso/estado del pack
    if (input.packId) {
      await supa.rpc("caes_pack_progreso", {
        p_pack: input.packId,
        p_total: input.total ?? null,
        p_procesados: input.procesados ?? null,
        p_fallidos: input.fallidosN ?? null,
        p_revision: input.revisionN ?? null,
        p_estado: input.estadoPack ?? null,
      });
    }
    return { ok: true };
  },
});
