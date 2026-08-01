# Audit de consommation RPC et plan d’optimisation vérifiable (BSC / Chainstack Free)

## 1) Résumé exécutif

L’architecture actuelle consomme correctement dans l’absolu, mais la multiplication des `reconcile()` par paire (`MAX_ACTIVE_PAIR_MONITORS=50` + `RECONCILE_SECONDS=15`) est déjà la contrainte principale pour un quota de 3 000 000 RU/mois. 

Avec la logique actuelle, la consommation non liée aux transactions métier dépasse le quota dès quelques paires actives, même sans activité WebSocket, à cause de la redondance de `eth_blockNumber` + `eth_getBlockByNumber` sur chaque listener périodique.

Objectif visé dans ce plan : **réduire de >=90% la charge HTTP de réconciliation pour 50 listeners** sans casser la logique d’ordre, de checkpoint, de reorg ni de fresh-start, et sans logique dépendante du provider.

## 2) Cartographie des appels RPC

## 2.1 Hypothèses de charge

- `RECONCILE_SECONDS = 15` (4 passes/minute)
- `MAX_ACTIVE_PAIR_MONITORS = N`
- `RPC_MAX_LOG_BLOCK_RANGE = 100`
- `RECONCILE` en cours = `N + 1` listeners actifs réguliers (`N` swaps + `pair-created`)
- Provider cost model: 1 unité RPC = 1 Request Unit.

## 2.2 Carte des appels par source

### Méthode: `getChainId`

- **Fichier source**
  - `src/app.ts` (startup)
  - `src/config/env.ts` (lecture de config dépendant du réseau)
  - `scripts/check-rpc.ts` (diagnostic)
- **Méthode JSON-RPC probable**: `eth_chainId`
- **Déclencheurs**: démarrage + diagnostic
- **Idempotent**: oui
- **Fréquence**:
  - minimum: 1 (startup)
  - moyen: 2 (startup + diagnostic)
  - pire: 1 par appel de diagnostic/restart
- **Duplication entre listeners**: non (appel central)

### Méthode: `getBlockNumber`

- **Fichier source**
  - `src/app.ts` (`heartbeat`, `pair-monitor start`, `canonicalBlockReader`)
  - `src/listeners/pair-created.listener.ts` via `CanonicalChainCoordinator`
  - `src/listeners/swap.listener.ts` via `CanonicalChainCoordinator`
  - `scripts/check-rpc.ts`
  - `src/chain/canonical-chain.coordinator.ts` (dans `execute`)
- **Méthode JSON-RPC probable**: `eth_blockNumber`
- **Déclencheurs**: démarrage, intervalle, heartbeat, réconciliation, WS diagnostics
- **Idempotent**: oui
- **Fréquence**:
  - minimum: 2 startup (`app` HTTP + heartbeat)
  - moyen (steady-state) : `2 * 4 * (N+1)` appels/minute (1 par listener/reconcile pour HTTP côté canonical)
  - pire: idem × duplication lors d’évènements WS déclenchant des passes immédiates
- **Duplication entre listeners**: forte (une série de `getBlockNumber` par listener toutes les 15s)

### Méthode: `getBlock` (`getBlockByNumber`)

- **Fichier source**
  - `src/app.ts` (`canonicalBlockReader.getBlock` au lancement + validate)
  - `src/chain/canonical-chain.coordinator.ts`
  - `src/heartbeat/heartbeat.ts` indirectement via `heartbeat` ? (non, only block numbers)
  - `src/execution/reconciliation` via `viem-reconciliation.gateway`
- **Méthode JSON-RPC probable**: `eth_getBlockByNumber`
- **Déclencheurs**
  - validation de tip canonical, préparation d’intervalle, cohérence checkpoint, détection reorg, validation de tête
  - dans recovery: `getBlock({ includeTransactions: true })` (différente sur retour)
- **Idempotent**: oui
- **Fréquence**:
  - minimum: 0 en cas d’absence de reorg/écarts
  - moyen: `1 + Δblocks` selon `checkpoint` (à rattraper)
  - pire: `1` par listener + `head` blocs manqués lors de backlog large
- **Duplication entre listeners**: élevée en cas de `reconcile` redondants

### Méthode: `getContractEvents` (`eth_getLogs`)

- **Fichier source**
  - `src/listeners/pair-created.listener.ts` (PairCreated)
  - `src/listeners/swap.listener.ts` (Swap)
  - `src/execution/viem-execution.gateway.ts` via `readContract` (pas de getLogs)
  - `scripts/check-rpc.ts` (diagnostic PairCreated)
  - `scripts/diagnose-pair-created.ts`
- **Méthode JSON-RPC probable**: `eth_getLogs`
- **Déclencheurs**
  - démarrage replay/prime
  - intervalle de réconciliation
  - événement WS -> réconciliation immédiate
  - diagnostic CLI
- **Idempotent**: oui si tri/validation par header + identifiant de log
- **Fréquence**
  - minimum: startup seulement par listener si checkpoint vierge
  - moyen: `0` en régime stable par listener si checkpoint déjà au head ; sinon `ceil((head-checkpoint)/100)` par listener
  - pire: chaque listener fait des scans non groupés
- **Duplication entre listeners**: maximale (même fenêtre d’event log par plusieurs listeners si backlog identique)

### Méthode: `readContract` / `getBytecode` / `getStorageAt` / `getCode`

- **Fichier source**
  - `src/discovery/token-metadata.service.ts` (`readContract`, `getBytecode`)
  - `src/security/token-risk.service.ts` (`readContract`, `getBytecode`, `getStorageAt`, `balanceOf` etc.)
  - `src/security/safety-probe.service.ts` (`simulateContract`)
  - `src/strategy/position-metrics.service.ts` (via `position-metrics.gateway`)
  - `src/execution/viem-execution.gateway.ts` (quotes, balances, allowance)
  - `src/recovery/viem-reconciliation.gateway.ts` (`readContract`)
- **Méthode JSON-RPC probable**: surtout `eth_call` et `eth_getCode` selon méthode
- **Déclencheurs**
  - découverte de pair, vérification de risque, préparation/exécution de trade, récupération/mesure
- **Idempotent**: en lecture = oui
- **Fréquence**: dépend du nombre de nouveaux tokens / sessions actives (non périodique)
- **Duplication**: possible, surtout si une même token est relue pendant recovery/retry

### Méthode: `getBalance`

- **Fichier source**
  - `src/app.ts` (wallet balance)
  - `src/execution/viem-execution.gateway.ts`
  - `src/recovery/viem-reconciliation.gateway.ts`
- **Méthode JSON-RPC probable**: `eth_getBalance`
- **Déclencheurs**: startup, préparation mesure, vérif post-transaction, recovery
- **Idempotent**: oui
- **Duplication**: faible/moyenne sur flux de trading/récupération

### Méthode: `getGasPrice`

- **Fichier source**
  - `src/app.ts` (snapshot métrique position)
- **Méthode JSON-RPC probable**: `eth_gasPrice`
- **Déclencheurs**: collecte métrique / exit monitor
- **Idempotent**: oui
- **Duplication**: faible (intervalle de monitoring)

### Méthode `estimateGas`

- **Fichier source**
  - `src/execution/viem-execution.gateway.ts` (via `walletClient.prepareTransactionRequest`)
- **Méthode JSON-RPC probable**: `eth_estimateGas`
- **Déclencheurs**: prépa transaction d’achat/vente/approval
- **Idempotent**: oui
- **Duplication**: liée au nombre de trades

### Méthode `getTransactionCount`

- **Fichier source**
  - `src/execution/viem-execution.gateway.ts`
- **Méthode JSON-RPC probable**: `eth_getTransactionCount`
- **Déclencheurs**: préparation de tx (prepareBuy/prepareSell/prepareApproval)
- **Idempotent**: oui
- **Duplication**: faible

### Méthode: `sendRawTransaction`

- **Fichier source**
  - `src/execution/viem-execution.gateway.ts`
- **Méthode JSON-RPC probable**: `eth_sendRawTransaction`
- **Déclencheurs**: soumission BUY/APPROVE/SELL
- **Idempotent**: non (si rejouée, double tx)
- **Duplication**: évitée par séquencement interne, mais à coût élevé si doublon

### Méthode: `getTransactionReceipt`

- **Fichier source**
  - `src/execution/viem-execution.gateway.ts` via `waitForTransactionReceipt`
  - `src/recovery/viem-reconciliation.gateway.ts`
- **Méthode JSON-RPC probable**: `eth_getTransactionReceipt`
- **Déclencheurs**: post-submission, recovery
- **Idempotent**: oui (lecture)
- **Duplication**: poll régulier tant que non finalisé

### Méthode: `getTransaction`

- **Fichier source**
  - `src/recovery/viem-reconciliation.gateway.ts` (observeTransaction)
- **Méthode JSON-RPC probable**: `eth_getTransactionByHash`
- **Déclencheurs**: recovery quand receipt manquant
- **Idempotent**: oui
- **Duplication**: en cas de retries recovery

### Abonnements WebSocket (`watchContractEvent`)

- **Fichier source**
  - `src/listeners/pair-created.listener.ts`
  - `src/listeners/swap.listener.ts`
- **Méthode JSON-RPC probable**: `eth_subscribe` (`logs`)
- **Déclencheurs**: démarrage listener + keepalive provider
- **Idempotent**: évènement non idempotent en lui-même (traitement de queue nécessaire)
- **Fréquence**: dépend de l’activité on-chain, non bornée statiquement
- **Duplication**: une par listener actuel (N + 1 subscriptions) ; duplication de traitement si un même bloc génère beaucoup de listeners actifs

## 3) Budget mensuel – calculs (capacité: 3 000 000 RU/mois)

### 3.1 Coût fixe par architecture actuelle

Soit `N` = paires actives surveillées.

En régulier sans nouvel événement, un reconcile listener coûte en pratique:
- `eth_blockNumber` + `eth_getBlockByNumber` = **2 appels**

Avec intervalle 15s:
- appels par minute = `(N + 1) * 2 * 4`
- appels/mois = `(N + 1) * 2 * 4 * 60 * 24 * 30`
- plus heartbeat: `2 * 30 * 24 * 60 = 86 400` appels

| N actifs | Coût reconnaissance/mois (sans WS) | Coût total/mois (avec heartbeat) |
| --- | ---: | ---: |
| 0 | 345 600 | 432 000 |
| 1 | 691 200 | 777 600 |
| 10 | 3 801 600 | 3 888 000 |
| 50 | 17 625 600 | 17 712 000 |

Interprétation: dès 10 paires actives, l’architecture actuelle dépasse déjà `3 000 000` RU/mois.

### 3.2 Séparation des coûts demandée

#### Coût fixe
- `PairCreatedListener` périodique: 2 appels/15s = 8 appels/min
- heartbeat RPC: 2 appels/min
- démarrage de processus: quelques appels ponctuels (`getChainId`, `readContract`)

#### Coût par paire
- en régime stable (sans événements): `8` appels/min par paire (due à la réconciliation périodique), donc `17280` appels/jour par paire
- ce coût n’évolue pas avec l’activité réelle des swaps

#### Coût par bloc
- rattrapage `B` blocs: `B` appels `eth_getBlockByNumber` + `ceil(B / 100)` appels `eth_getLogs`
- exemple `B = 500` => `500 + 5 = 505` + overhead de tête (~2)
- la granularité des chunks est déjà inclusive correcte dans le code:
  - plage de chunk = `fromBlock` à `toBlock` inclus
  - `toBlock = chunkEnd = cursor + chunkSize - 1`

#### Coût par événement (approche actuelle)
- un événement WS déclenche une réconciliation immédiate du listener concerné
- coût additionnel pratique: `eth_blockNumber` + `eth_getBlockByNumber` + 1 appel `eth_getLogs` (plage du chunk) = ~3 appels
- mécanisme actuel de coalescence limite les doublons d’un même listener tant qu’une réconciliation est en cours, mais pas entre listeners

#### Coût par transaction on-chain
- `quote` / simulation: `eth_call`
- achat/live: `quote` + balances + préparation tx (`eth_getTransactionCount`, `eth_gasPrice`, `eth_estimateGas`) + `eth_sendRawTransaction` + `eth_getTransactionReceipt` + checks post-réconciliation
- vente/live: similaire à l’achat, plus `allowance` (`eth_call`) éventuellement + approval si nécessaire
- approval: `getBalance` + `estimateGas` + `sendRawTransaction` + `wait receipt` + balances

## 4) Scénarios demandés

Notation: `N=50`, `I=15`, `rpcTail=100`.

### 4.1 0 paire active

- listeners: 1 (PairCreated)
- baseline: `345 600/mo + heartbeat 86 400 = 432 000` RU/mois
- marge: confortable au regard du quota, mais non évolutif avec montées de paires.

### 4.2 1 paire active

- listeners: 2
- baseline: `691 200 + 86 400 = 777 600` RU/mois
- marge: confortable seule, mais déjà du même ordre que 3× base 0-paire.

### 4.3 10 paires actives

- listeners: 11
- baseline: `3 888 000` RU/mois
- dépassement: `+888 000` RU/mois (~29% de dépassement)

### 4.4 50 paires actives

- listeners: 51
- baseline: `17 712 000` RU/mois
- dépassement: ~**+14,7M** RU/mois (~5,9× le quota)

### 4.5 Activité WebSocket faible

Hypothèse de travail: 10 réconciliations WS déclenchées/minute (toutes paires confondues).

- coût additionnel ≈ `10 * 3 = 30` appels/min
- total ≈ `408 + 30 + heartbeat` = `438` appels/min
- mensualisation: `438*43200 = 18 921 600` + `heartbeat` similaire => dépassement massif

### 4.6 Activité WebSocket importante

Hypothèse: 50 réconciliations WS/minute (1 événement/pair/minute, en moyenne).

- coût additionnel ≈ `150` appels/min
- total ≈ `558` appels/min
- mensualisation: `24 105 600` + heartbeat

### 4.7 Panne WebSocket, fallback périodique uniquement

- aucun appel ws, pas de réactivité événementielle immédiate
- coût revient au mode « baseline périodique », donc déjà hors quota dès 10 paires
- latence d’observation = pas moins de `RECONCILE_SECONDS`

### 4.8 Retard de 500 blocs à rattraper avec `chunkSize=100`

Pour un listener en retard de 500 blocs (création/incident/reconnexion):
- `eth_getLogs` par chunks de 100 inclusifs => `ceil(500/100)=5` appels :
  - `[start..start+99], [start+100..start+199], ..., [start+400..start+499]`
- `eth_getBlockByNumber`: au moins `500` appels (validation de header)
- overhead head/tip: ~2
- total pour ce listener: `507` appels RPC minimum
- pour 50 listeners en même retard: `25 350` appels en une passe de rattrapage (non récurrent)

## 5) Comparaison des options d’architecture

### A) Architecture actuelle (par pair, WS + intervalle)
- **Consommation**: O(`N`) appels `eth_blockNumber`/`eth_getBlockByNumber`/`eth_getLogs` même sans événements.
- **Latence**: faible (WS déclenche immédiatement, fallback 15s).
- **Risque perte/doublon**: faible si `canonical` valide; coût élevé et duplication entre listeners.
- **Checkpoints**: robustes par `listenerKey` (`pair-created`, `swap:<pair>`).
- **Reorg/fresh-start**: comportement établi, satisfaisant.
- **Add/remove pair**: simple (création/suppression d’un listener).
- **Risque quota**: critique.

### B) Intervalle central + coalescence des demandes
- **Consommation**: réduction du nombre de passes périodiques en O(1)
- **Latence**: similaire (coalescence + intervalle), dégradation faible.
- **Risque perte/doublon**: gestion de queue nécessaire, risque bas si idempotence sur logs.
- **Checkpoints**: conservés, mais avancées déclenchées depuis orchestrateur.
- **Reorg/fresh-start**: inchangés si réutilisation du `CanonicalChainCoordinator`.
- **Add/remove pair**: géré par scheduler central.
- **Notes**: gain de l’ordre de 30–60% en fix cost selon implémentation, insuffisant seul pour le seuil 90%.

### C) `eth_getLogs` groupé (multi-adresses) 

- **Consommation**: baisse importante des appels logs, de O(`N`) à quasi-O(1) par chunk.
- **Latence**: proche du courant si gardé en déclenchement WS+intervalle.
- **Risque**
  - perte si tri/filtrage de logs multi-adresses mal fait
  - complexité à préserver un replay propre par paire.
- **Checkpoints**: il faut un split par paire après récupération, sinon checkpoint par listener impossible.
- **Reorg/fresh-start**: possible si l’ordre global est trié `blockNumber/transactionIndex/logIndex` puis rerouté.
- **Add/remove pair**: gérer souscription WS dynamique et mapping de partition.

### D) WS partagé pour plusieurs adresses

- **Consommation**: réduit uniquement la couche WS (subscriptions), pas le coût HTTP de réconciliation si on garde `N` réconciliations.
- **Latence**: bonne.
- **Risque**: faible.
- **Checkpoints**: inchangés.
- **Reorg/fresh-start**: inchangé.
- **Add/remove pair**: besoin de mise à jour dynamique de l’array d’adresses.
- **Notes**: option utile, mais insuffisante seule pour -90% réconciliation HTTP.

### E) WS comme signal + lecture HTTP canonicale groupée (recommandée)

- **Consommation**: forte réduction des appels HTTP périodiques et des `eth_getLogs` dupliqués.
- **Latence**: évènements WS = quasi immédiat, fallback 15s.
- **Risque perte/doublon**: faible si la dé-duplication est maintenue au niveau (pair, block, tx, log index) et tri global.
- **Checkpoints**: conservés par `swap:<pair>`; seulement progression conditionnelle après succès complet du lot.
- **Reorg/fresh-start**: inchangé via `CanonicalChainCoordinator` (head, confirmations, reorg session).
- **Add/remove pair**: naturel via routeur d’abonnement partagé.
- **Conformité au quota**: atteinte potentielle du -90%.

### F) Polling HTTP central sans WS Swap

- **Consommation**: bonne si orchestration centralisée et `eth_getLogs` groupé ; moins que l’option D/B.
- **Latence**: dégradée jusqu’à 15s (voire plus en cas de blocage).
- **Risque**: faible côté détection, plus élevé sur réactivité.
- **Checkpoints**: centralisés et robustes.
- **Reorg/fresh-start**: inchangé.
- **Add/remove pair**: centralisé.
- **Usage**: bon pour mode « conservative » (si WS instable), mais moins performant pour cas réactifs.

### Pourquoi pas `eth_subscribe` newHeads “automatique”

- `newHeads` peut multiplier les traitements de scan si chaque notification déclenche une lecture canonique brute.
- coût d’orchestration des triggers peut vite dépasser gain attendu si on réplique la logique de réconciliation sur chaque notification.
- avec ce quota, l’optimisation se fait d’abord côté batching `getLogs` / coalescence et non via explosion de notifications.

## 6) Recommandation minimale (cœur retenu)

### Recommandation
Choisir **E + C** (mix) avec un passage par lot centralisé :

1. 1 abonnement WS partagé pour les événements `Swap` des paires actives (adresse array).
2. 1 orchestration de réconciliation centralisée qui:
   - maintient un ensemble de paires "sales" (event-driven + fallback)
   - appelle un **seul** flux de `getContractEvents` par chunk (`from/to` de 100 blocs max) avec `address: [pairA, pairB, ...]`
   - trie les logs (par block/tx/log), route vers les handlers de session.
3. Les checkpoints `swap:<pair>` restent utilisés, mais ne sont avancés qu’après succès du lot pour cette paire.
4. Un tick périodique global (15s) déclenche les paires non marquées via fallback, sans 50 timers séparés.

### Résultat attendu sur 50 pairs

Le coût fixe passe d’O(50) à quasi O(1) côté `blockNumber`/`getBlockByNumber`, puis appels `eth_getLogs` deviennent groupés.

À titre d’ordre de grandeur:
- avant: 17,6M/mois (juste réconciliation)
- après: ~1,0 à 1,1M/mois (réconciliation + heartbeat) selon présence d’évènements
- gain: >90% pour la composante réconciliation.

## 7) Plan d’implémentation testable

### Étape 1 — Mesure + garde-fou quota
- **Fichiers concernés**
  - `src/` (nouveau module de métrique RPC)
  - `docs/` (plan/monitoring)
- **Interfaces**
  - `RpcUsageSink` avec méthode `record(method, source, latencyMs, ok)`
  - wrapper légère autour de `publicClient` + `wsClient` en mode instrumentation (sans changer semantique)
- **Migration checkpoint**: aucune
- **Tests**
  - unit: compteur incrémental par méthode/source
  - test de seuil d’alerte hebdomadaire (simulateur 3M/mois)
- **Métriques**
  - `rpc_requests_total{method,source}`
  - `rpc_error_total`
  - `reconcile_calls_total` et `reconcile_duration_ms`
  - `ws_events_total`
- **Go / stop**
  - Go: instrumentation active avec 30min de trafic réel sans erreur de comptage
  - Stop: impossible de tracer un calltype ou hausse d’erreur incohérente

### Étape 2 — Bus de swap WS partagé + réduction des watchers
- **Fichiers concernés**
  - `src/app.ts`
  - `src/listeners/` (nouveau `shared-swap-events.ts` ou équivalent)
  - `src/listeners/swap.listener.ts` (réduction du rôle)
  - `src/runtime`/`monitoring` pour intégration lifecycle
- **Interfaces**
  - `SwapEventBus`: `subscribe(pair)`, `unsubscribe(pair)`, `onLogs(batch)`
  - `SwapLogConsumer`: `onBatch(logsByPair)`
- **Migration checkpoint**
  - aucune (mêmes checkpoints `swap:<pair>`).
- **Tests**
  - unit: souscriptions dynamiques add/remove pair
  - unit: coalescence d’un même bloc de plusieurs paires
  - intégration: un seul WS sub vs plusieurs
- **Métriques**
  - `ws_subscriptions_count`
  - `ws_redundant_handlers`
- **Go / stop**
  - Go: un WS subscribe maximum avec `N` pairs actives
  - Stop: fuite mémoire sur subscribe/unsubscribe

### Étape 3 — Réconciliation centralisée + batch d’`eth_getLogs`
- **Fichiers concernés**
  - `src/app.ts`
  - `src/listeners/swap.listener.ts` (découplage vers orchestrateur)
  - `src/chain/canonical-chain.coordinator.ts` (ajout options de callback batch si besoin, sinon wrapper externe)
  - nouveaux services: `src/reconciliation/swap-reconciliation-orchestrator.ts`
- **Interfaces**
  - `SwapBatchReconciler`: `request(pair)`/`reconcileAll()`
  - `PairCheckpointStore`: lecture/écriture existant
  - `CanonicalRange` avec tri, partition par `swapRange` + `address[]`
- **Migration checkpoint**
  - conserver la même table `listener_checkpoints`
  - règle: checkpoint d’une paire uniquement mis à jour si son segment a été confirmé sans erreur
- **Tests**
  - unit: chunking inclusif 100 (`[from;to]`) et partitions par paire
  - unit: aucun saut entre blocs/transactions/logs
  - test régression de reprise partielle
  - intégration: 250 blocs -> chunks 100/100/50 (ordre logique)
  - intégration: panne sur chunk intermédiaire = aucun checkpoint partiel
- **Métriques**
  - `batch_eth_getLogs_calls_per_min`
  - `chunks_per_reconcile`
  - `dropped_duplicates_total`
- **Go / stop**
  - Go: coût moyen <30% actuel dans un scénario 50paires sans événements pendant 2h
  - Stop: erreur de checkpoint partiel ou perte d’événement détectée

### Étape 4 — Fallback pur periodic + anti-duplication
- **Fichiers concernés**
  - `src/app.ts`
  - `src/monitoring/monitor-scheduler.ts`
  - `src/listeners/swap.listener.ts`
- **Interfaces**
  - `ReconcileScheduler`: `onTick()`, `onDemand(pair)`
  - `PendingPairsQueue`
- **Migration checkpoint**: aucune
- **Tests**
  - WS down simulation: uniquement tick toutes 15s + checkpoints progressifs
  - pas de doublons sur fenêtre sans événements
- **Métriques**
  - `retries_total`
  - `fallback_only_reconciles_total`
- **Go / stop**
  - Go: latence max conforme au besoin métier
  - Stop: drift de checkpoint >1 cycle sur 2 cycles consécutifs

### Étape 5 — Validation de compatibilité réorg / fresh-start / issue #15
- **Fichiers concernés**
  - `src/chain/canonical-chain.coordinator.ts`
  - `src/chain/canonical-chain-health.provider.ts`
  - `src/recovery/*`
  - tests existants (`tests/canonical-chain-coordinator.test.ts`, `tests/listener-confirmations.test.ts`)
- **Interfaces**
  - garder les mêmes frontières de réconciliation et d’éviction
- **Migration checkpoint**
  - aucun changement de schéma; conservation de `listenerKey`, `checkpoint` et `blockHash`
- **Tests**
  - tests déjà présents de canonicality/retry/reorg
  - ajouter cas batch multi-adresses + rollback entre paires
  - ajouter test d’absence de checkpoint partiel en cas d’erreur dans la moitié du batch
- **Métriques**
  - `reorg_events_total`
  - `manual_review_due_to_reconcile_fail`
- **Go / stop**
  - Go: reorg/fresh-start identiques sur scénario de reprise
  - Stop: divergence de checkpoints ou replay incorrect en présence de reorg

## 8) Risques ouverts

- `eth_getLogs` avec adresse multiple + filtres peut modifier la logique de désambiguïsation d’évènements si ABI/format d’adresse change -> besoin de tests de tri et de route.
- Les paires sans événement pendant longtemps peuvent rester peu actives; il faut garder une stratégie de checkpoint d’avance (éviter la rechute de `fromBlock`).
- Une erreur de batch partiel doit être strictement évitée : rollback par paire et ne jamais marquer partiellement avancé.
- Vérifier le coût de polling du fallback sur récupération d’erreur RPC (exponential backoff recommandé).
- Les métriques/alertes doivent être opérationnelles avant déploiement pour confirmer la réduction réelle à >90%.

## 9) Vérifiabilité (livrables de preuve)

- rapport mensuel de consommation par méthode avant/après (JSON-LD ou CSV), incluant:
  - `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs`, `eth_call`, `eth_sendRawTransaction`, `eth_getTransactionReceipt`
- preuve des invariants:
  - chunks `<=100` inclusifs
  - ordre `(blockNumber, transactionIndex, logIndex)` conservé
  - checkpoint jamais avancé si erreur RPC sur un chunk
- preuve de non-fuite d’URL déjà partiellement en place via `sanitizeRpcError` + tests.
