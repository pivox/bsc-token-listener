# Architecture

## Flux

```text
Factory PairCreated
        |
        v
PairResolver -- garde seulement Token/WBNB
        |
        v
TokenSession + PairMonitor dédié
        |
        v
SwapClassifier
        |
        v
StrategyEngine
   |           |
Security     Execution
   |           |
   +---- Store +
```

## Démarrage sans entrée historique

L’écoute `PairCreated` s’abonne d’abord par WebSocket, lit ensuite uniquement le bloc courant par HTTP, puis traite les logs tamponnés. Une installation fraîche ne rejoue donc pas plusieurs centaines de blocs de créations et ne peut pas acheter tardivement un token ancien.

Les sessions déjà persistées suivent une règle différente :

- `WAITING_FIRST_BUY` est expirée au redémarrage ;
- `HOLDING` est reprise seulement si la totalité de la coupure tient dans `EVENT_BACKFILL_BLOCKS` ;
- sinon la session passe en `ERROR` et demande une réconciliation manuelle.

## Ordre et idempotence

Chaque `PairMonitor` possède une file séquentielle. Les logs reçus pendant le backfill initial sont tamponnés. Les lots sont triés par :

```text
(blockNumber, transactionIndex, logIndex)
```

Un événement est ensuite inséré dans le store avec l’identifiant `transactionHash:logIndex`; la stratégie ne le traite que si l’insertion est nouvelle. Les logs arrivent par WebSocket et sont également relus par HTTP à intervalle régulier.

Le curseur complet permet de ne compter que les achats strictement postérieurs au Swap de notre entrée.

## Reprise

- `HOLDING` est restauré dans la limite de la fenêtre de backfill.
- `SELL_PENDING` revient à `HOLDING` après redémarrage.
- `WAITING_FIRST_BUY` devient `EXPIRED`.
- `CHECKING` et `BUY_PENDING` passent en `ERROR`, car le wallet doit être réconcilié manuellement.
- Un hash d’achat ou de vente est persisté dès sa diffusion, avant l’attente du reçu.
- Un résultat post-diffusion ambigu prend le statut de trade `UNKNOWN` et arrête la session.

## Résilience RPC

- transport HTTP avec fallback entre plusieurs URLs ;
- transport WebSocket avec reconnexion et fallback ;
- contrôle de santé séparé HTTP/WebSocket ;
- rattrapage HTTP incrémental de `PairCreated` et `Swap` ;
- déduplication en base avant traitement métier ;
- refus de reprendre une position avec un trou supérieur à la fenêtre configurée.
