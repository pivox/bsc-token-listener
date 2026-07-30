# RPC Optimization Handoff — Phase 3A

- Branche: `main`
- Commit de départ: `eefd50b`

- Fichiers modifiés:
  - `src/app.ts`
  - `src/listeners/swap.listener.ts`
  - `src/monitoring/monitor-scheduler.ts`
  - `src/monitoring/monitor-reconcile-request.ts`
  - `src/monitoring/swap-reconcile-orchestrator.ts` (nouveau)
  - `tests/swap-reconcile-orchestrator.test.ts` (nouveau)
  - `tests/listener-confirmations.test.ts`
  - `src/runtime/reorg-monitor-admission.ts`
  - `src/runtime/reorg-replay-lifecycle.ts`
  - `src/runtime/runtime-shutdown.ts`

- Architecture mise en place:
  - Orchestrateur central `SwapReconcileOrchestrator` avec:
    - un timer unique,
    - file de demandes par paire,
    - coalescence des signaux,
    - exécution non concurrente avec relance si signal pendant un passage,
    - possibilité d’arrêt/draine.
  - `SwapListener` en mode central: callback WS ne fait plus de réconciliation locale, il signale l’orchestrateur.
  - `src/app.ts` enregistre/déréférence les listeners dans l’orchestrateur à l’admission et à la suppression.
  - Admission/replay: aucun passage métier nouveau tant que le drapeau replay/recovery n’autorise pas le démarrage; activation WS gardée après `activateAfterReplay`.

- Tests exécutés et résultats:
  - `./node_modules/.bin/tsx --import ./tests/setup-env.ts --test tests/swap-reconcile-orchestrator.test.ts` ✅
  - `./node_modules/.bin/tsx --import ./tests/setup-env.ts --test tests/listener-confirmations.test.ts` ✅
  - `./node_modules/.bin/tsx --import ./tests/setup-env.ts --test tests/monitor-scheduler.test.ts` ✅
  - `./node_modules/.bin/tsx --import ./tests/setup-env.ts --test tests/reorg-monitor-admission.test.ts tests/reorg-replay-lifecycle.test.ts tests/runtime-shutdown.test.ts` ✅
  - `npm run check` ✅
  - `npm run build` ✅

- Éléments restant à faire:
  - Phase 3A complète côté orchestration/reconciliation: centralisation des passages Swap.
  - Prochaine étape: E + C complet: réconciliation HTTP groupée multi-adresses (`eth_getLogs`) et rate limiter ciblé.

- Problèmes connus:
  - Le dépôt contient d’autres modifications non liées à cette phase (ex: scripts/monitoring/RPC/canonical), préservées volontairement.
  - Le mécanisme de fallback multi-provider et la limitation fine de débit ne sont pas encore activés.

PHASE 3A TERMINÉE
