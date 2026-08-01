# BSC Token Listener — TokenRiskReport

Bot TypeScript/viem qui :

1. écoute les nouvelles paires PancakeSwap V2 `Token/WBNB` ;
2. ouvre une écoute `Swap` séparée par paire ;
3. attend le premier achat ;
4. calcule et persiste un `TokenRiskReport` ;
5. autorise ou bloque l’entrée selon la politique ;
6. compte les achats suivants ;
7. vend après le nombre cible d’achats.

Le mode par défaut est **`dry-run`**. Aucun argent réel n’est envoyé.

## Ce que vérifie TokenRiskReport V1

- présence du bytecode ;
- interface BEP-20 minimale ;
- réserve WBNB minimale ;
- propriétaire actif via `owner()` ;
- proxy EIP-1967 ou minimal proxy EIP-1167 ;
- sélecteurs de fonctions sensibles : mint, blacklist, taxes, limites, pause, upgrade ;
- proportion de LP envoyée aux adresses de burn ;
- simulation complète achat puis revente avec `SafetyProbe` ;
- estimation de la taxe d’achat, taxe de vente et perte aller-retour.

Ces contrôles réduisent le risque mais ne garantissent jamais qu’un token restera revendable. Un propriétaire peut modifier le comportement après le rapport, retirer la liquidité ou utiliser une logique non reconnue.

## Politique de décision

```env
RISK_POLICY=allow-only
```

- `allow-only` : seuls les rapports `ALLOW` peuvent acheter ;
- `block-only` : les rapports `REVIEW` sont acceptés, seuls les `BLOCK` sont refusés.

Le mode live impose automatiquement `allow-only`.

## Installation

```bash
cp .env.example .env
npm install
docker compose up -d
npm run db:migrate
npm run rpc:check
npm run check
npm test
npm run dev
```

## Configurer un provider RPC BSC

Configurez la liste prioritaire `BSC_HTTP_RPC_URLS`. Si elle est absente, le bot utilise `BSC_HTTP_URLS`, puis `BSC_HTTP_RPC_URL` pour compatibilité.

Configurez la liste prioritaire `BSC_WS_RPC_URLS`. Si elle est absente, le bot utilise `BSC_WSS_URLS`, puis `BSC_WS_RPC_URL` pour compatibilité.

La clé du provider peut être incluse directement dans l’URL (`https://.../v1/<API_KEY>`).

Aucun endpoint réel ne doit jamais être committé dans le dépôt ; seuls des placeholders doivent rester dans `.env.example`.

`RPC_MAX_LOG_BLOCK_RANGE` fixe la taille maximum d’une plage d’appels `eth_getLogs` utilisée par le coordinator et les diagnostics. 

Cette valeur dépend de la limite du provider (100 chez Chainstack Developer). Utilisez la valeur la plus basse demandée par votre provider.

Pour Chainstack Developer, utilisez :

```bash
RPC_MAX_LOG_BLOCK_RANGE=100
```

Lancer une vérification RPC :

```bash
npm run rpc:check
```

Le mécanisme reste agnostique du provider (NodeReal, Chainstack ou tout autre endpoint EVM compatible).

## SafetyProbe

Le probe doit être déployé une fois. Commencer sur testnet :

```env
BSC_NETWORK=testnet
BSC_HTTP_RPC_URL=https://...
PRIVATE_KEY=0x...
CONFIRM_PROBE_DEPLOYMENT=I_UNDERSTAND_TESTNET
```

```bash
npm run deploy:probe
```

Reporter ensuite les deux valeurs affichées :

```env
SAFETY_PROBE_ADDRESS=0x...
RISK_PROBE_CALLER=0x...
RISK_PROBE_REQUIRED=true
```

`RISK_PROBE_CALLER` doit posséder au moins `RISK_PROBE_AMOUNT_BNB` sur le réseau, même pour `eth_call`, car le nœud valide le solde simulé.

## Tables PostgreSQL

- `discovered_tokens` : tous les tokens trouvés via `PairCreated` ;
- `token_sessions` : état de chaque paire suivie ;
- `swap_events` : événements dédupliqués ;
- `trades` : achats et ventes simulés ou réels ;
- `trade_transactions` : étapes on-chain `BUY`, `APPROVE` et `SELL`, avec hash,
  nonce, wallet, reçu, gas et snapshots de soldes ;
- `reconciliation_decisions` : décisions de reprise idempotentes et auditables ;
- `token_risk_reports` : rapports complets ;
- `listener_checkpoints` : progression des listeners pendant l’exécution courante ;
- `fresh_start_runs` : cutoff confirmé immutable installé à chaque lancement.

Exemple :

```sql
SELECT token_address, pair_address, score, verdict, created_at
FROM token_risk_reports
ORDER BY created_at DESC;
```

### Cycle de vie des transactions

Un trade métier utilise les états `CREATED`, `SUBMITTED`, `CONFIRMED`,
`REVERTED`, `UNKNOWN`, `FAILED` ou `SIMULATED`. En live, chaque transaction est
préparée et signée localement afin de calculer son hash et son nonce. Ces
informations sont persistées avant l'appel de diffusion. La transaction signée
elle-même n'est jamais stockée ni journalisée.

Une erreur RPC après tentative de diffusion ou pendant l'attente du reçu produit
`UNKNOWN`, jamais un échec on-chain supposé. Un reçu en échec produit `REVERTED`.
Les transactions incertaines ne sont pas rediffusées automatiquement.

```sql
SELECT
  t.trade_id,
  t.side,
  t.status AS trade_status,
  x.step,
  x.status AS transaction_status,
  x.transaction_hash,
  x.nonce,
  x.gas_cost_wei,
  x.receipt_status
FROM trades t
LEFT JOIN trade_transactions x ON x.trade_id = t.trade_id
ORDER BY t.created_at DESC, x.created_at;
```

### Fresh-start obligatoire

Chaque lancement commence au head BSC actuellement confirmé. Le bot ne rejoue
aucun bloc antérieur et ne reprend aucune ancienne intention d’achat,
d’approbation ou de vente.

Avant le dashboard et les listeners, une transaction PostgreSQL atomique :

- place toutes les anciennes sessions non terminales en `MANUAL_REVIEW` avec
  la raison `FRESH_START_CUTOFF` ;
- place les décisions de sortie `PENDING` ou `EXECUTING` en
  `MANUAL_REVIEW` ;
- ancre tous les checkpoints sur le cutoff et remplace le journal canonique par
  son header ;
- écrit un audit immutable dans `fresh_start_runs`.

Les sessions `CLOSED`, `REJECTED` et `EXPIRED` ne sont pas modifiées. Les
tokens, rapports, trades, transactions et diagnostics historiques restent dans
PostgreSQL. Les sessions mises en quarantaine sont exclues de la récupération
périodique, même si elles conservent une référence d’exécution historique.

Une erreur RPC pendant la lecture du head ou du header empêche entièrement le
fresh-start : aucune session, décision ou checkpoint n’est alors modifié. Le
processus conserve un verrou PostgreSQL de session pendant toute sa durée de
vie ; une seconde instance partageant la même base refuse de démarrer.

### Récupération pendant l’exécution courante

La passe initiale de réconciliation après crash n’existe plus. Après activation
des listeners, les passes périodiques restent disponibles uniquement pour les
incidents créés depuis le cutoff de l’exécution courante. Une seule instance
exécute une passe à la fois ; les sessions sont réclamées avec un bail expirant
et les opérations listener déjà engagées sont drainées avant la reprise.

Cette récupération observe la blockchain en lecture seule avant toute décision :

- une transaction `pending` est laissée en attente sans rediffusion ;
- un reçu confirmé reconstruit les montants depuis les snapshots persistés ou
  les soldes historiques au bloc du reçu et le gas ; une transaction ultérieure
  du même wallet dans ce bloc rend la mesure ambiguë ;
- un revert applique un état métier sûr ;
- un hash absent, une mesure impossible ou une exécution ambiguë passe en
  `MANUAL_REVIEW` ;
- une `MANUAL_REVIEW` créée pendant l’exécution courante et conservant une
  référence d’exécution peut être réexaminée en lecture seule ;
- une intention sans transaction enfant peut reprendre automatiquement, mais un
  achat exige toujours un `TokenRiskReport` persisté et compatible avec la
  politique de risque.

Une erreur RPC ne fait avancer aucun checkpoint blockchain et son diagnostic ne
conserve que le type d’erreur. Une passe périodique non chevauchante s’exécute
selon :

```env
RECOVERY_INTERVAL_SECONDS=30
RECOVERY_LEASE_SECONDS=60
RECOVERY_STALE_SECONDS=180
```

Les états d’exécution transitoires ne sont réclamés qu’après
`RECOVERY_STALE_SECONDS`. Cette fenêtre empêche une autre instance saine de
reprendre simultanément une intention encore en cours.

Le heartbeat et le dashboard affichent le nombre de sessions en reprise, le
nombre de revues manuelles, la dernière passe terminée et le dernier type
d’erreur sûr. Pour investiguer une revue manuelle :

```sql
SELECT
  pair_address,
  status,
  recovery_attempts,
  recovery_error,
  last_reconciled_at
FROM token_sessions
WHERE status = 'MANUAL_REVIEW'
ORDER BY updated_at DESC;
```

Ne jamais rediffuser manuellement une transaction tant que son hash et son reçu
n’ont pas été vérifiés sur le réseau configuré.

### Saturation des moniteurs

Lorsque `MAX_ACTIVE_PAIR_MONITORS` est atteint, les sessions éligibles restent
persistées dans `token_sessions` et forment une file reconstructible. Une place
libérée déclenche automatiquement une nouvelle admission. La priorité est
déterministe et orientée sécurité :

1. positions `HOLDING`, de la plus ancienne à la plus récente ;
2. sessions `WAITING_FIRST_BUY`, de la plus ancienne à la plus récente ;
3. adresse de paire comme dernier critère stable.

Le plafond n’est jamais augmenté automatiquement. Une erreur au démarrage d’un
listener laisse la session en file pour une nouvelle tentative. Un échec
`WAITING_FIRST_BUY` n’empêche pas l’admission de la suivante ; un échec
`HOLDING` réserve en revanche sa place afin qu’une position ouverte ne soit
jamais évincée par une simple observation. Si une position `HOLDING` réapparaît
après reprise alors que la capacité est pleine, elle préempte le listener
`WAITING_FIRST_BUY` actif le moins prioritaire. Les sessions
`WAITING_FIRST_BUY` expirent après `PAIR_MONITOR_TTL_MINUTES`, même sans avoir
obtenu de listener. Les actifs ignorés et les sessions terminales sont retirés
de la file.

Un échec RPC de démarrage reste visible par le listener `PairCreated` : la file
continue à traiter les autres candidates, mais le checkpoint de découverte
n’avance pas pour la plage concernée.

Le heartbeat et le dashboard exposent la capacité totale, les moniteurs actifs,
la profondeur de file, les admissions échouées lors de la dernière passe et
l’âge de la plus ancienne attente.

### Continuité de chaîne

`BLOCK_CONFIRMATIONS=5` est la latence de sécurité par défaut. Un événement WebSocket ne déclenche qu’une lecture HTTP canonique : il ne fournit jamais seul un log métier. À chaque lancement, seuls les blocs dont le numéro est strictement supérieur au cutoff fresh-start sont traitables. Le journal garde ensuite les 128 derniers headers ; les reorgs dans cette fenêtre sont rembobinés et rejoués automatiquement. Une reorg qui nécessiterait de lire au niveau du cutoff ou avant suspend la chaîne en `MANUAL_REVIEW`.

Le heartbeat et le dashboard indiquent le head confirmé, le tip/hash canonique,
l’état `HEALTHY` / `RECONCILING` / `MANUAL_REVIEW`, ainsi que le dernier reorg
(heure de détection, profondeur, ancêtre, événements orphelins et rejoués). En
cas d’échec RPC, les dernières valeurs validées restent visibles mais sont
marquées `STALE`; elles ne sont jamais affichées comme saines.

## Dashboard local

Le bot expose une interface locale de supervision. Elle affiche :

- les tokens écoutés, achetés, vendus et en erreur ;
- le solde du wallet public quand une clé est configurée ;
- les positions ouvertes et leur progression vers le nombre cible d’achats ;
- le PnL latent estimé et le profit réalisé en BNB ;
- le score `TokenRiskReport`, les taxes estimées, les swaps observés et une chronologie ;
- l’état et le backlog de la réconciliation après crash ;
- les liens vers BscScan pour le token, la paire et les transactions.
- la prochaine évaluation de sortie, le PnL économique net, la liquidité de
  référence, le probe de vente et l’état trailing.

La liste applique sa priorité avant pagination : `MANUAL_REVIEW` apparaît en
premier, puis `WAITING_FIRST_BUY`, puis les autres états actifs. Le mode
`EXECUTION_MODE=dry-run` reste la valeur par défaut.

Configuration par défaut :

```env
DASHBOARD_ENABLED=true
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=3000
DASHBOARD_REFRESH_SECONDS=5
DASHBOARD_MAX_ROWS=250
```

Après `npm run dev`, ouvrir :

```text
http://127.0.0.1:3000/dashboard
```

Le PnL latent utilise la cotation `getAmountsOut` de PancakeSwap V2 et applique
l’estimation de taxe de vente du rapport de risque lorsqu’elle est disponible.
Pour une position live clôturée, le dashboard distingue :

- le PnL brut calculé à partir des variations réelles de soldes ;
- le gas confirmé de l'achat, de l'approval éventuel et de la vente ;
- le PnL net après déduction de ce gas.

Les cotations dry-run restent explicitement marquées comme simulations et ne sont
jamais présentées comme des montants réels.

### Politique de sortie configurable

Toutes les valeurs `EXIT_*` et `TARGET_BUYS_AFTER_ENTRY` de `.env.example`
sont modifiables depuis le formulaire « Politique de sortie ». Une modification
est refusée sans écoute loopback, sans `DASHBOARD_ACTIONS_ENABLED=true`, ou sans
la confirmation live dédiée. Le formulaire impose une prévisualisation, une
confirmation explicite et la révision courante ; une révision périmée retourne
un conflit sans modifier PostgreSQL. Le bouton de reset restaure les valeurs
du `.env`. Chaque modification est auditée.

Le profil par défaut évalue toutes les 15 secondes, limite une position à
30 minutes, applique un stop-loss de 10 %, un take-profit de 20 % et détecte
une baisse de liquidité de 20 %. Le probe de vente est renouvelé toutes les
60 secondes et immédiatement avant chaque vente.

Le formulaire et les ventes manuelles restent verrouillés par défaut :

```env
DASHBOARD_ACTIONS_ENABLED=false
CONFIRM_DASHBOARD_TRADING_ACTIONS=
```

## Tests PostgreSQL

La suite standard `npm test` ne nécessite pas PostgreSQL. La CI exécute aussi
la suite d’intégration PostgreSQL sur chaque push et pull request avec un
service PostgreSQL 16 jetable.

Pour reproduire cette validation localement, démarrer PostgreSQL puis fournir
explicitement une base de test :

```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgresql://bscbot:bscbot@127.0.0.1:5432/bscbot \
  npm run test:postgres
```

Cette commande crée des schémas temporaires isolés, exécute les migrations
depuis une base vide puis une seconde fois pour vérifier leur idempotence,
valide la sérialisation exacte des `bigint` et les contraintes de
déduplication, puis supprime les schémas.

Elle inclut aussi un parcours vertical déterministe : log `PairCreated`
confirmé, admission de la paire, achats observés, rapport de risque persisté,
achat et vente dry-run, déduplication, puis fermeture de session. Le scénario
utilise PostgreSQL réel, mais aucun RPC public et aucune transaction
blockchain.

Ce parcours ne remplace pas les niveaux suivants de l’issue #12 : contrats de
test et `SafetyProbe` sur chaîne locale ou fork, puis scénario testnet
explicitement opt-in sans secret dans la CI.

La validation complète avant commit reste :

```bash
npm run check
npm test
TEST_DATABASE_URL=postgresql://bscbot:bscbot@127.0.0.1:5432/bscbot \
  npm run test:postgres
npm run build
```

Le serveur reste lié à `127.0.0.1` par défaut. Ne définir `DASHBOARD_HOST=0.0.0.0` que derrière un pare-feu ou un reverse proxy correctement protégé.

## Passage en live

Le live reste verrouillé tant que toutes ces conditions ne sont pas réunies :

```env
EXECUTION_MODE=live
PRIVATE_KEY=0x...
CONFIRM_LIVE_TRADING=I_UNDERSTAND_REAL_FUNDS
RISK_POLICY=allow-only
SAFETY_PROBE_ADDRESS=0x...
```

Tester longuement en dry-run avant toute activation.

## Limites connues de la V1

- pas d’analyse de source BscScan ;
- pas de liste complète des détenteurs ;
- pas d’intégration aux lockers LP ;
- détection de sélecteurs basée sur le bytecode, donc faux positifs et faux négatifs possibles ;
- les métriques dépendent de la disponibilité du RPC et du contrat
  `SafetyProbe` configuré ;
- pas de mempool ni d’exécution dans le même bloc.
