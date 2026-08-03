// actReconciliar.ts — activity de RECONCILIACIÓN al cerrar el pack.
// Tras el fan-out, algunos documentos de trabajador (EPI, DNI, formación) que NO
// llevan el nombre de la empresa quedaron "sin asignar" si se procesaron antes que
// el ALTA que crea a su trabajador. Esta pasada los re-engancha por el DNI/CIF que
// el clasificador YA leyó (guardado en observaciones), ahora que todas las
// empresas/trabajadores del lote ya existen.
import * as df from "durable-functions";
import { InvocationContext } from "@azure/functions";
import { Supa } from "../shared/supa";
import { tenantConfig } from "../shared/config";

df.app.activity("reconciliarSinAsignar", {
  handler: async (input: any, ctx: InvocationContext) => {
    const { origen, instanciaId } = input;
    try {
      const supa = new Supa(tenantConfig(origen));
      const r = await supa.rpc<any>("caes_reconciliar_sin_asignar", { p_instancia: instanciaId });
      return { ok: true, r };
    } catch (e: any) {
      ctx.error(`reconciliarSinAsignar fallo: ${e?.message}`);
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
});
