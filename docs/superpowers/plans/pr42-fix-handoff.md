# PR42 - Handoff opératoire (swap reconcile orchestrator / listener)

PROMPT 1 TERMINÉ — ORCHESTRATEUR VALIDÉ
PROMPT 2 TERMINÉ — BATCHING ET CHECKPOINTS VALIDÉS

## Validation finale de la PR 42

### Architecture finale

- `SwapReconcileOrchestrator` conserve uniquement les signaux, la coalescence, le timer central, `requestAndWait()` et les reruns bornés.
- `SwapLogBatchReconciler` prend un snapshot immuable, charge les checkpoints individuels, prépare une plage canonique unique, partitionne les adresses et route les logs validés dans l'ordre global `(blockNumber, transactionIndex, logIndex)`.
- Un signal WebSocket ne lit aucun log HTTP directement. La vivacité WebSocket provient des contrôles techniques `eth_blockNumber`; une erreur de souscription arrête l'ancien watcher, applique un backoff exponentiel borné et réinstalle une seule souscription sur un provider de secours.
- Les lectures HTTP partagent un limiteur global à intervalle régulier. Chaque tentative initiale, retry, bascule et contrôle de santé passe par la même primitive de mesure et de mise à jour de santé.
- Les erreurs de transport/provider ouvrent le circuit; les reverts et erreurs métier déterministes sont transmis sans dégrader le provider.
- `rpcUsage` compte les requêtes réseau réelles, erreurs, 429, retries, bascules, latences et l'activité de réconciliation. Son snapshot est exposé dans le heartbeat, le JSON dashboard et la page HTML.
- La diffusion transactionnelle distingue `PENDING_BROADCAST`, `UNKNOWN`, `BROADCASTED` et `REJECTED`. Une diffusion ambiguë n'est jamais rejouée automatiquement.

### Stratégie transactionnelle des checkpoints

- Les clés restent individuelles sous la forme `swap:<adresse-paire>`.
- Le premier bloc scanné est le minimum réellement requis par les checkpoints ou `createdBlock` du snapshot.
- Chaque paire ignore les logs déjà couverts par son propre checkpoint.
- Pour chaque chunk : headers canoniques, tous les lots RPC, validation complète, décisions métier, puis `setManyAtomically()`.
- `setManyAtomically()` exécute tous les upserts dans une transaction PostgreSQL unique avec rollback intégral en cas d'erreur.
- Une erreur RPC, une réponse partielle, un hash incohérent, un retrait de listener ou un échec métier ne fait avancer aucun checkpoint du chunk.

### Appels `eth_getLogs` avant/après

Avec `SWAP_LOG_BATCH_MAX_ADDRESSES=20`, par chunk :

| Paires | Avant | Après |
| ---: | ---: | ---: |
| 1 | 1 | 1 |
| 10 | 10 | 1 |
| 50 | 50 | 3 |

Le test de 50 paires sur trois chunks vérifie explicitement `appels = chunks x lots`, soit `3 x 3 = 9`. Avec un lot de 10, 50 paires produisent 5 appels par chunk. Une plage de 250 blocs avec une limite de 100 est découpée en 100, 100 et 50.

### Retries, limites et transactions ambiguës

- `RPC_MAX_HTTP_RPS` est appliqué globalement, y compris pour 1 RPS, les appels concurrents, retries, failovers et health checks HTTP; le maximum de configuration reste 25.
- `RPC_MAX_HTTP_RETRIES=N` signifie exactement un essai initial puis au maximum N nouvelles tentatives.
- Les 429 respectent `Retry-After` en secondes ou date HTTP; sinon un backoff exponentiel borné avec jitter injectable est utilisé.
- Un failover `eth_getLogs` abandonne tous les résultats partiels du provider précédent et recommence la plage demandée.
- `eth_sendRawTransaction` n'est jamais retry automatiquement.
- Succès et `already known` deviennent `BROADCASTED`; timeout ou réponse perdue deviennent `UNKNOWN`; rejet définitif avant diffusion devient `REJECTED` et ne produit aucun faux succès.
- Chaque provider conserve séparément `configuredMaxLogBlockRange` et `currentSafeLogBlockRange`. Seuls plusieurs succès `eth_getLogs` consécutifs peuvent faire remonter progressivement la limite sûre.

### Audit explicite des constats de revue

- Plus de boucle infinie : validé par les tests de coalescence, rerun unique et `stopAndDrain()`.
- `start()`, `startForReplay()` et `activateAfterReplay()` attendent le rattrapage : validé.
- `eth_getLogs` réellement groupé et checkpoints atomiques : validé.
- `rpc:check` et vrai proxy `wsClient.getChainId()` : validé sur la chaîne configurée.
- WebSocket sain sans Swap et watcher réellement basculé sans duplication : validé.
- Reverts métier sans provider `down` : validé.
- Rate limiter, nombre exact de retries et `Retry-After` : validés.
- `rpcUsage` branché aux tentatives réseau et exposé : validé.
- Rejet TX définitif, `UNKNOWN`, `already known` et absence de double diffusion : validés.
- Configuration moderne prioritaire avec legacy uniquement en fallback : validé.
- Limite de logs propre au provider conservée pendant les health checks : validé.

### Suivi de revue du 1er août 2026

- Les sessions actives silencieuses exécutent désormais `expireIfNeeded()` une fois par chunk concerné, même lorsqu'aucun log Swap n'est retourné.
- La finalisation shallow reorg attend toutes les activations post-replay avant de promouvoir l'état `RECOVERED`; un échec d'activation conserve la récupération en échec.
- `SwapListener.stopAndDrain()` attend toutes les opérations suivies avec `Promise.allSettled()`, même si l'une d'elles rejette.
- Les trois régressions disposent de tests rouges puis verts dans les suites batch, coordinateur canonique et confirmations listener.

### Fichiers modifiés

- `.env.example`
- `README.md`
- `docs/superpowers/plans/pr42-fix-handoff.md`
- `scripts/check-rpc.ts`
- `src/app.ts`
- `src/chain/canonical-chain.coordinator.ts`
- `src/config/env.ts`
- `src/dashboard/dashboard.page.ts`
- `src/dashboard/dashboard.ts`
- `src/execution/execution.types.ts`
- `src/execution/trade-executor.ts`
- `src/heartbeat/heartbeat.ts`
- `src/listeners/swap.listener.ts`
- `src/monitoring/rpc-usage.ts`
- `src/monitoring/swap-log-batch-reconciler.ts`
- `src/monitoring/swap-reconcile-orchestrator.ts`
- `src/rpc/clients.ts`
- `src/storage/repositories.ts`
- `src/types/domain.ts`
- `tests/canonical-chain-repository.test.ts`
- `tests/canonical-chain-coordinator.test.ts`
- `tests/check-rpc.test.ts`
- `tests/config-env.test.ts`
- `tests/dashboard-page.test.ts`
- `tests/heartbeat-service.test.ts`
- `tests/listener-confirmations.test.ts`
- `tests/rpc-client-pool.test.ts`
- `tests/rpc-usage.test.ts`
- `tests/swap-log-batch-reconciler.test.ts`
- `tests/swap-reconcile-orchestrator.test.ts`
- `tests/trade-executor.test.ts`

### Résultats exacts

- `npm run check` : succès, code 0.
- `npm test` : 523 tests, 523 succès, 0 échec, code 0.
- Suites ciblées de suivi de revue : 120 tests, 120 succès, 0 échec.
- `npm run build` : succès, code 0.
- `git diff --check` : succès, aucune sortie, code 0.
- `node --test --import tsx tests/check-rpc.test.ts` : 9 tests, 9 succès, 0 échec.
- `npm run rpc:check` : succès, code 0; mainnet configuré, chain ID HTTP/WS 56, écart de tête 0, fenêtre `PairCreated` lue sans erreur. Aucun endpoint n'est consigné.
- `npm run test:postgres` : non exécuté, `TEST_DATABASE_URL` absent.

### Limites restantes

- Le test PostgreSQL réel reste à exécuter dans un environnement fournissant `TEST_DATABASE_URL`; les tests repository transactionnels avec rollback passent localement.
- Les compteurs `rpcUsage` sont en mémoire et repartent de zéro au redémarrage; aucune URL, clé ou valeur `PRIVATE_KEY` n'est exposée dans leur snapshot.

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
