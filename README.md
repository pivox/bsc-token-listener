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
- `token_risk_reports` : rapports complets ;
- `listener_checkpoints` : reprise après coupure.

Exemple :

```sql
SELECT token_address, pair_address, score, verdict, created_at
FROM token_risk_reports
ORDER BY created_at DESC;
```

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
