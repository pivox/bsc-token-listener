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
- `listener_checkpoints` : reprise après coupure.

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

### Reprise après crash

Au démarrage, le bot réconcilie toutes les sessions interrompues avant d’activer
le listener `PairCreated` et les listeners `Swap`. Une seule instance exécute une
passe à la fois grâce à un verrou PostgreSQL ; les sessions sont réclamées avec
un bail expirant et chaque session n’est traitée qu’une fois par passe.

La réconciliation observe la blockchain en lecture seule avant toute décision :

- une transaction `pending` est laissée en attente sans rediffusion ;
- un reçu confirmé reconstruit les montants depuis les soldes et le gas ;
- un revert applique un état métier sûr ;
- un hash absent, une mesure impossible ou une exécution ambiguë passe en
  `MANUAL_REVIEW` ;
- une intention sans transaction enfant peut reprendre automatiquement, mais un
  achat exige toujours un `TokenRiskReport` persisté et compatible avec la
  politique de risque.

Une erreur RPC ne fait avancer aucun checkpoint blockchain et son diagnostic ne
conserve que le type d’erreur. Après la barrière initiale, une passe périodique
non chevauchante s’exécute selon :

```env
RECOVERY_INTERVAL_SECONDS=30
RECOVERY_LEASE_SECONDS=60
```

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

## Dashboard minimal

Le bot expose une interface de supervision **strictement en lecture seule**. Elle affiche :

- les tokens écoutés, achetés, vendus et en erreur ;
- le solde du wallet public quand une clé est configurée ;
- les positions ouvertes et leur progression vers le nombre cible d’achats ;
- le PnL latent estimé et le profit réalisé en BNB ;
- le score `TokenRiskReport`, les taxes estimées, les swaps observés et une chronologie ;
- l’état et le backlog de la réconciliation après crash ;
- les liens vers BscScan pour le token, la paire et les transactions.

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

## Tests PostgreSQL

La suite unitaire standard ne nécessite pas PostgreSQL. Le cycle de vie SQL peut
être validé séparément sur une base de test jetable :

```bash
TEST_DATABASE_URL=postgresql://bscbot:bscbot@127.0.0.1:5432/bscbot \
  npm run test:postgres
```

Cette commande crée un schéma temporaire, exécute la migration deux fois, vérifie
la sérialisation exacte des `bigint` et les contraintes de déduplication, puis
supprime le schéma.

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
- pas de surveillance continue des changements de paramètres après l’achat ;
- pas de mempool ni d’exécution dans le même bloc.
