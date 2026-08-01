# PR42 - Handoff opératoire (swap reconcile orchestrator / listener)

PROMPT 1 TERMINÉ — ORCHESTRATEUR VALIDÉ
PROMPT 2 TERMINÉ — BATCHING ET CHECKPOINTS VALIDÉS

## Réconciliation Swap groupée
- `SwapReconcileOrchestrator` conserve le timer unique, les signaux, la coalescence, les demandes avec attente et les reruns.
- `SwapLogBatchReconciler` prend un snapshot de listeners, charge les checkpoints `swap:<pair>`, prépare une plage via `CanonicalChainCoordinator`, partitionne les adresses et route les logs validés dans l’ordre canonique global.
- Le coordinateur est appelé avec `ignoreStoredCheckpoint: true` et `persistCheckpoint: false`; seuls les checkpoints individuels sont persistés par le batch.
- `CheckpointRepository.setManyAtomically()` écrit tous les checkpoints d’un chunk dans une transaction PostgreSQL unique. Une lecture, validation, décision métier ou écriture en échec ne fait avancer aucun checkpoint du chunk.
- Appels `eth_getLogs` par chunk avec lot de 20: 1 paire = 1, 10 paires = 1, 50 paires = 3. Sur 250 blocs avec une limite de 100 et 50 paires: `3 chunks x 3 lots = 9` appels.
- Tests batch: `21/21` passés; atomicité repository ciblée: `2/2`; orchestrateur: `13/13`; confirmations listeners: `31/31`.

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
