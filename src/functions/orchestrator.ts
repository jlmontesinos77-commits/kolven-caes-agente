// orchestrator.ts — flujo Durable con fan-out.
// 1) reclama trabajo de la cola (clasificar_pack)
// 2) prepara: descarga+descomprime ZIP, carga catalogo/contexto (serializable)
// 3) fan-out: Task.all de clasificarUnDoc (1 activity por documento, en paralelo)
// 4) agrega y completa el trabajo

import * as df from "durable-functions";
import { OrchestrationContext, OrchestrationHandler } from "durable-functions";

const orchestrator: OrchestrationHandler = function* (ctx: OrchestrationContext) {
  const input = ctx.df.getInput() as { origen: string };
  const origen = input?.origen ?? "kolven";

  // 1) Reclamar trabajo
  const trabajo: any = yield ctx.df.callActivity("reclamarTrabajo", { origen });
  if (!trabajo) {
    return { estado: "cola_vacia" };
  }

  const packId = trabajo.entrada?.pack_id;
  ctx.df.setCustomStatus({ fase: "preparando", pack: packId });

  // 2) Preparar (descargar ZIP, listar docs, cargar catalogo) -> indice serializable
  const prep: any = yield ctx.df.callActivity("prepararPack", { origen, trabajoId: trabajo.id, packId });
  if (!prep.ok) {
    yield ctx.df.callActivity("finalizarTrabajo", {
      origen, trabajoId: trabajo.id, worker: trabajo.claim_token, ok: false,
      error: prep.error, packId, estadoPack: "error",
    });
    return { estado: "error_preparacion", error: prep.error };
  }

  const total = prep.documentos.length;
  ctx.df.setCustomStatus({ fase: "clasificando", pack: packId, total, generados: 0 });

  // 3) Fan-out: una activity por documento (doc trae fuente/blob/indice/nombre)
  const tareas = prep.documentos.map((doc: any) =>
    ctx.df.callActivity("clasificarUnDoc", {
      origen, packId, instanciaId: prep.instanciaId,
      driveId: prep.driveId, rutaBasePartes: prep.rutaBasePartes,
      catalogo: prep.catalogo, doc,
    })
  );
  const resultados: any[] = yield ctx.df.Task.all(tareas);

  // 4) Agregar
  const okCount = resultados.filter((r) => r.ok).length;
  const fallidos = resultados.filter((r) => !r.ok).length;
  const revision = resultados.filter((r) => r.revision).length;

  yield ctx.df.callActivity("finalizarTrabajo", {
    origen, trabajoId: trabajo.id, worker: trabajo.claim_token, ok: true,
    packId, estadoPack: "completado",
    salida: { total, ok: okCount, fallidos, revision, resultados },
    total, procesados: okCount, fallidosN: fallidos, revisionN: revision,
  });

  ctx.df.setCustomStatus({ fase: "completado", pack: packId, total, generados: okCount, fallidos, revision });
  return { estado: "completado", total, ok: okCount, fallidos, revision };
};

df.app.orchestration("orchestrator", orchestrator);
