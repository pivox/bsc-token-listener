# BSC Token Listener Bot

V1 TypeScript/viem pour BNB Smart Chain et PancakeSwap V2.

Le bot :

1. écoute `PairCreated` sur la factory PancakeSwap V2 ;
2. conserve uniquement les nouvelles paires contenant WBNB ;
3. ouvre une session et une écoute `Swap` dédiées à chaque paire ;
4. attend le premier achat confirmé ;
5. exécute les contrôles BEP-20, liquidité et achat/revente simulé ;
6. achète en mode `live`, ou simule l’entrée en `dry-run` ;
7. compte les transactions d’achat uniques strictement postérieures à notre entrée ;
8. vend après le nombre configuré, `10` par défaut.

> Le mode par défaut est `dry-run`. Aucun ordre réel n’est envoyé tant que `EXECUTION_MODE=live` n’est pas configuré.

## Périmètre exact de cette V1

- BSC mainnet ou testnet.
- PancakeSwap **V2** seulement.
- Paires directes `Token/WBNB` seulement.
- Détection basée sur les logs confirmés, pas sur le mempool.
- WebSocket pour la faible latence, avec rattrapage HTTP périodique et déduplication.
- Au démarrage frais, seules les paires créées dans le bloc courant ou après sont éligibles : aucun achat tardif sur un historique ancien.
- Un « achat » correspond à un événement `Swap` où WBNB entre dans la paire et le token en sort.
- Les 10 achats sont 10 **hashes de transaction uniques**, pas 10 événements issus d’une même transaction multi-route.
- Le premier achat déclencheur et notre propre achat ne sont pas comptés.

La détection optionnelle des déploiements directs (`to = null`) journalise les contrats BEP-20 probables. Elle ne détecte pas toutes les créations internes via `CREATE`/`CREATE2`.

## Installation

Prérequis : Node.js 22+, npm et un provider RPC BSC avec HTTP + WebSocket.

```bash
cp .env.example .env
npm install
npm run check
npm run rpc:check
npm run dev
```

Renseigner au minimum dans `.env` :

```dotenv
BSC_HTTP_URLS=https://votre-endpoint-http
BSC_WSS_URLS=wss://votre-endpoint-websocket
EXECUTION_MODE=dry-run
```

Les listes RPC acceptent plusieurs URLs séparées par des virgules. viem utilise un transport de secours en cas d’échec. Le bot force les souscriptions WebSocket et relit périodiquement les blocs par HTTP pour récupérer un éventuel trou de connexion. Les logs reçus pendant la synchronisation initiale sont tamponnés puis traités dans l’ordre `(bloc, transaction, log)`.

## PostgreSQL

Le stockage mémoire suffit pour observer le fonctionnement, mais il ne survit pas à un redémarrage.

```bash
docker compose up -d postgres
```

Puis :

```dotenv
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://bscbot:bscbot@127.0.0.1:5439/bscbot
POSTGRES_AUTO_MIGRATE=true
```

Lancer :

```bash
npm run db:migrate
npm run dev
```

Les tables enregistrent les sessions, swaps dédupliqués, trades et déploiements directs détectés.

## Sonde de sécurité achat/revente

`contracts/SafetyProbe.sol` effectue, dans un appel simulé :

```text
BNB -> token -> approve -> token -> BNB
```

La fonction termine toujours par l’erreur Solidity `ProbeResult`. C’est volontaire :

- `eth_call` récupère le résultat sans modifier la chaîne ;
- une transaction réelle envoyée par erreur est entièrement annulée, hors frais de gas.

Compilation :

```bash
forge build
```

Déploiement exemple :

```bash
forge create contracts/SafetyProbe.sol:SafetyProbe \
  --rpc-url "https://votre-endpoint-http" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast
```

Reporter ensuite l’adresse :

```dotenv
SAFETY_PROBE_ADDRESS=0x...
REQUIRE_SAFETY_PROBE=true
MAX_ROUND_TRIP_LOSS_BPS=3500
```

En `dry-run`, renseigner aussi `SIMULATION_ACCOUNT` avec une adresse BSC publique disposant d’un solde suffisant pour que le nœud accepte la valeur simulée.

La sonde réduit certains risques évidents, mais ne garantit jamais la revente future. Un contrat malveillant peut reconnaître l’adresse de la sonde, modifier ses règles après l’achat, blacklister le wallet, retirer la liquidité ou changer ses taxes.

## Passage en mode live

N’activer le live qu’après une longue observation en `dry-run` :

```dotenv
EXECUTION_MODE=live
PRIVATE_KEY=0x...
SAFETY_PROBE_ADDRESS=0x...
STORAGE_DRIVER=postgres
MAX_CONCURRENT_POSITIONS=1
BUY_AMOUNT_BNB=0.001
```

Règles de sécurité recommandées :

- wallet dédié avec un faible solde ;
- aucune seed phrase dans le projet ;
- clé privée uniquement dans `.env`, jamais dans Git ;
- endpoint d’envoi séparé possible via `BSC_TX_HTTP_URL` ;
- montant très faible pendant les premiers essais ;
- surveillance manuelle du wallet et des transactions.

## Configuration principale

| Variable | Rôle |
|---|---|
| `EXECUTION_MODE` | `dry-run` ou `live` |
| `BUY_AMOUNT_BNB` | montant de chaque entrée |
| `TARGET_BUYS_AFTER_ENTRY` | nombre d’achats uniques avant vente |
| `MIN_WBNB_LIQUIDITY` | réserve WBNB minimale |
| `BUY_SLIPPAGE_BPS` | tolérance d’achat en points de base |
| `SELL_SLIPPAGE_BPS` | tolérance de vente en points de base |
| `MAX_ROUND_TRIP_LOSS_BPS` | perte maximale acceptée par la sonde |
| `PAIR_WAIT_FIRST_BUY_SECONDS` | expiration avant premier achat |
| `MAX_ACTIVE_PAIR_MONITORS` | plafond de souscriptions dynamiques |
| `MAX_CONCURRENT_POSITIONS` | plafond de positions ouvertes |
| `EVENT_BACKFILL_BLOCKS` | fenêtre maximale de reprise après redémarrage |
| `EVENT_RECONCILE_SECONDS` | fréquence du rattrapage HTTP pendant l’exécution |

`100 bps = 1 %`.

## Machine d’état

```text
WAITING_FIRST_BUY
        |
        v
     CHECKING ------> REJECTED
        |
        v
    BUY_PENDING ----> ERROR
        |
        v
      HOLDING -- compte 1..10 achats uniques
        |
        v
    SELL_PENDING
       |     \
       |      \ échec: retour HOLDING et nouvelle tentative
       v
      CLOSED
```

## Commandes

```bash
npm run dev          # écoute avec rechargement
npm run build        # compilation TypeScript
npm run typecheck    # contrôle des types
npm test             # tests unitaires
npm run check        # typecheck + tests
npm run rpc:check    # vérifie chainId, router, factory et WBNB
npm run db:migrate   # crée les tables PostgreSQL
npm run contract:build
```

## Structure

```text
src/
├── abi/           ABI PancakeSwap, ERC-20 et SafetyProbe
├── config/        environnement, réseau, adresses officielles
├── discovery/     résolution des paires Token/WBNB
├── execution/     approve, achat, vente, nonce et reçus
├── listeners/     PairCreated, Swap par paire, déploiements directs
├── rpc/           clients HTTP/WSS, fallback, santé, nonce
├── security/      BEP-20, liquidité, sonde aller-retour
├── storage/       mémoire et PostgreSQL
├── strategy/      machine d’état et classification des swaps
└── types/         modèle métier
```

## Codex CLI

- `AGENTS.md` contient les consignes réellement découvertes par Codex CLI.
- `agent.md` est conservé comme alias lisible conformément à la demande.

## Limites connues avant production

- Une entrée basée sur un log confirmé arrivera normalement dans un bloc ultérieur au premier acheteur.
- Les réorganisations sont signalées, mais une réconciliation automatique complète n’est pas encore implémentée.
- Une position dont la coupure dépasse `EVENT_BACKFILL_BLOCKS` passe en `ERROR` au lieu de continuer avec un compteur incomplet.
- Un arrêt pendant `BUY_PENDING`, ou un reçu RPC ambigu après diffusion, exige une vérification manuelle du wallet avant reprise. Le hash est persisté dès sa diffusion lorsque cela est possible.
- Les proxies, launchpads, PancakeSwap V3/Infinity et les routes multi-hop ne sont pas couverts.
- Le nombre de souscriptions WebSocket autorisé dépend du provider RPC.
- Le projet ne constitue ni une garantie de profit ni une protection complète contre les honeypots/rug pulls.

Voir `docs/roadmap.md` avant toute utilisation avec un capital significatif. Les contrôles réellement exécutés sur cette archive sont détaillés dans `docs/validation.md`.

## Sources techniques

- PancakeSwap V2 — adresses officielles : https://developer.pancakeswap.finance/contracts/v2/addresses
- PancakeSwap Router V2 : https://github.com/pancakeswap/pancake-swap-periphery/blob/master/contracts/interfaces/IPancakeRouter02.sol
- viem — `watchContractEvent` : https://viem.sh/docs/contract/watchContractEvent
- viem — `simulateContract` : https://viem.sh/docs/contract/simulateContract
- viem — WebSocket transport : https://viem.sh/docs/clients/transports/websocket
- BNB Smart Chain : https://docs.bnbchain.org/
- Codex CLI et `AGENTS.md` : https://developers.openai.com/codex/agent-configuration/agents-md
