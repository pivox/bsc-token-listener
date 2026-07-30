# PR42 - Handoff opératoire (swap reconcile orchestrator / listener)

## Branche courante
- `chore/issue-15-rpc-ha-observability`

## Fichiers modifiés
- `src/monitoring/swap-reconcile-orchestrator.ts`
- `src/listeners/swap.listener.ts`
- `src/app.ts`
- `tests/swap-reconcile-orchestrator.test.ts`
- `tests/listener-confirmations.test.ts`

## Nouveau contrat orchestrateur / listener
- Séparation explicite des 3 responsabilités:
  - `signal(pair?)`: callback non bloquant utilisé par les callbacks WS.
  - `requestAndWait(pair)`: demande avec attente utilisée par `start`, `startForReplay`, `activateAfterReplay` et tests de démarrage/réconciliation manuelle.
  - `runCanonicalReconcile` sur le listener: exécution réelle du passage, sans nouvel appel/signal vers l’orchestrateur.
- `SwapListener` ne crée plus de promesse non observée côté WS.
- Les reruns restent gérés uniquement par l’orchestrateur.

## Tests exécutés
- `node --test --import tsx tests/swap-reconcile-orchestrator.test.ts`
- `node --test --import tsx tests/listener-confirmations.test.ts`
- `npm run check`
- `npm run build`
- `git diff --check`

## Résultats
- Tests ciblés: `13` + `31` tests passés, `0` échec.
- `npm run check`: OK.
- `npm run build`: OK.
- `git diff --check`: OK.

## Points restant à corriger dans les prompts suivants
- Aucun blocage fonctionnel identifié au sujet de PR #42.
- Surveiller ensuite les changements déjà présents dans la branche autour de la télémétrie RPC/diagnostic avant de poursuivre d’autres refactors.
