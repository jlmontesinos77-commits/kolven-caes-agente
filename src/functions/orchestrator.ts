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
      error: prep.error, packId, estadoPack: "error", permanente: true,
    });
    return { estado: "error_preparacion", error: prep.error };
  }

  const total = prep.documentos.length;
  ctx.df.setCustomStatus({ fase: "clasificando", pack: packId, total, generados: 0 });

  // 3) Fan-out POR LOTES en TRES FASES (enfoque escalonado: organizar antes de mezclar).
  //    Fase 1 EMPRESAS  = apertura/adhesion/PSS/REA -> crean/consolidan empresas.
  //    Fase 2 CENSO      = ITA/relacion, TC2/RNT, contratos/altas, fichas de maquina ->
  //                        materializan trabajadores y maquinas (de una ITA salen decenas
  //                        de trabajadores de golpe).
  //    Fase 3 ACREDITAC. = el resto -> ya casan por DNI/matricula contra el censo.
  //    Barrera entre fases: la fase N no arranca hasta que la N-1 ha terminado, para
  //    que cada capa tenga construida la de la que depende.
  const LOTE = 8;
  const docs: any[] = prep.documentos;
  const numFase1: number = prep.numFase1 ?? 0;
  const numFase2: number = prep.numFase2 ?? 0;
  const resultados: any[] = [];

  // Rangos [inicio, fin) de cada fase sobre la lista ya ordenada por fase.
  const fases: Array<[number, number]> = [
    [0, numFase1],
    [numFase1, numFase1 + numFase2],
    [numFase1 + numFase2, docs.length],
  ];

  for (let f = 0; f < fases.length; f++) {
    const [desde, hasta] = fases[f];
    for (let i = desde; i < hasta; i += LOTE) {
      const grupo = docs.slice(i, Math.min(i + LOTE, hasta));
      const tareas = grupo.map((doc: any) =>
        ctx.df.callActivity("clasificarUnDoc", {
          origen, packId, instanciaId: prep.instanciaId,
          driveId: prep.driveId, rutaBasePartes: prep.rutaBasePartes,
          catalogo: prep.catalogo, doc,
        })
      );
      const parcial: any[] = yield ctx.df.Task.all(tareas);
      for (const r of parcial) resultados.push(r);
      ctx.df.setCustomStatus({ fase: `clasificando_f${f + 1}`, pack: packId, total: docs.length, procesados: resultados.length });
    }
    // Tras cerrar la fase 2 (censo completo), reconciliar: engancha por DNI/CIF los
    // documentos de trabajador que llegaron antes de existir su trabajador. Así la
    // fase 3 arranca con el censo ya reconciliado.
    if (f === 1) {
      ctx.df.setCustomStatus({ fase: "reconciliando_censo", pack: packId });
      yield ctx.df.callActivity("reconciliarSinAsignar", { origen, instanciaId: prep.instanciaId });
    }
  }

  // 3b) RECONCILIACIÓN FINAL: re-enganchar los "sin asignar" restantes por el DNI/CIF
  //     ya leído, ahora que todas las empresas/trabajadores del lote existen.
  ctx.df.setCustomStatus({ fase: "reconciliando", pack: packId });
  yield ctx.df.callActivity("reconciliarSinAsignar", { origen, instanciaId: prep.instanciaId });

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
