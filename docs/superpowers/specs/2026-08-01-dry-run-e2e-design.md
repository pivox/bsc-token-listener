# Parcours E2E dry-run avec PostgreSQL — Conception

## Objectif

Ajouter à l’issue #12 un test vertical déterministe qui prouve le parcours
métier principal depuis un log `PairCreated` confirmé jusqu’à la fermeture
d’une position simulée :

`PairCreated → session → achats observés → TokenRiskReport → achat dry-run → achats suivants → vente dry-run → CLOSED`.

Le test utilise PostgreSQL réel et les composants de production. Les entrées
blockchain restent des fixtures injectées : aucun RPC public, wallet, secret ou
transaction on-chain n’est utilisé. La chaîne locale et les contrats
`SafetyProbe` font l’objet du lot suivant de #12.

## Périmètre

### Inclus

- admission d’une paire Token/WBNB à partir de `PairCreated` ;
- persistance de la découverte, des métadonnées et de la session ;
- ingestion de vrais objets de logs par `PairCreatedListener` et
  `SwapListener` ;
- validation de l’identité canonique des logs et classification des swaps ;
- déduplication `transactionHash + logIndex` via l’identifiant métier existant ;
- transitions réelles de `SessionEngine` ;
- persistance du `TokenRiskReport` `ALLOW` avant l’entrée ;
- calcul du montant d’entrée et `TradeExecutor` réel en `dry-run` ;
- persistance des trades `BUY` et `SELL` avec le statut `SIMULATED` ;
- sortie après le nombre configuré d’achats suivants ;
- rejeu du même log sans seconde transition ni second trade ;
- deux demandes de vente concurrentes sans double vente ;
- assertions directes sur l’état PostgreSQL final et la provenance des lignes ;
- documentation de la commande locale et de sa couverture.

### Exclus

- démarrage complet du processus `app.ts` ;
- serveur JSON-RPC factice ;
- Anvil/Hardhat, fork BSC et déploiement Solidity ;
- comportement live ou testnet ;
- modification de la politique de risque ou de sortie ;
- activation automatique de `EXECUTION_MODE=live`.

## Approches considérées

### 1. Parcours vertical avec blockchain déterministe injectée — retenu

Les listeners, services métier, repositories et PostgreSQL sont réels. Un petit
coordinateur de fixture fournit une plage confirmée et ses headers, tandis que
les lecteurs retournent des logs déterministes. Cette approche traverse les
frontières importantes sans reproduire tout JSON-RPC et conserve une PR ciblée.

### 2. Bootstrap complet de `app.ts`

Cette option se rapproche davantage du processus de production, mais `app.ts`
construit actuellement de nombreuses dépendances globales. Le rendre entièrement
injectable élargirait fortement la PR et mélangerait refonte du bootstrap et
preuve du parcours métier.

### 3. Processus externe et faux serveur JSON-RPC

Cette option serait plus black-box, mais nécessiterait d’émuler une large partie
de JSON-RPC et du WebSocket attendue par viem. Elle serait plus lente, plus
fragile et ferait doublon avec le futur lot chaîne locale.

## Architecture

### `PairAdmissionService`

Le callback `onPair` actuellement défini dans `app.ts` est extrait dans un
service de production focalisé sur l’admission d’une paire. Il dépend de petits
ports typés :

- recherche de session par paire et sauvegarde de session ;
- vérification de la liste d’actifs ignorés ;
- upsert de la découverte ;
- lecture des métadonnées ;
- notification non bloquante au scheduler de monitoring ;
- horloge injectable pour rendre les timestamps déterministes.

Le service conserve exactement le comportement actuel : paire existante ou
ignorée, restauration après réapparition, rejet d’un token non compatible,
double upsert avant/après métadonnées, création de `WAITING_FIRST_BUY`, puis
signal au scheduler. `app.ts` ne garde que le câblage de ces dépendances.

Cette extraction évite que le test recopie un callback de production et fournit
une frontière réutilisable au futur harness chaîne locale.

### Harness PostgreSQL isolé

Le scénario vit dans `tests/postgres/dry-run-e2e.test.ts`. Il crée un schéma
unique, exécute toutes les migrations SQL dans l’ordre, puis utilise un adapter
de base dont chaque connexion applique ce `search_path`. Le schéma est supprimé
en `finally`.

Les repositories réels utilisés sont :

- `SessionRepository` ;
- `DiscoveredTokenRepository` ;
- `SwapEventRepository` ;
- `RiskReportRepository` ;
- `TradeRepository`.

Le test n’accède au SQL directement que pour préparer le schéma et vérifier les
preuves finales qui n’ont pas d’API de lecture publique.

### Blockchain déterministe

Un coordinateur de fixture implémente seulement le contrat
`ConfirmedRangeCoordinator`. Pour chaque passage, il appelle `processChunk`
avec une plage connue et une map de `CanonicalBlock` cohérente. Les lecteurs de
logs renvoient des objets ayant la même forme que viem : numéros et hashes de
bloc, transaction index, log index et arguments ABI déjà décodés.

Le test passe par les méthodes publiques des listeners ; il ne doit pas appeler
directement `SessionEngine.onSwap` pour le scénario principal. Les watchers
restent muets et ne créent aucun accès réseau.

## Flux du scénario principal

1. `PairCreatedListener` reçoit une plage confirmée contenant une paire
   Token/WBNB.
2. `PairAdmissionService` persiste la découverte et une session
   `WAITING_FIRST_BUY` avec métadonnées déterministes.
3. `SwapListener` ingère le nombre d’achats requis par
   `ENTRY_OBSERVATION_BUYS`.
4. `SwapEventRepository.claim` persiste chaque événement en `PROCESSING` avant
   son traitement.
5. Au seuil d’entrée, `SessionEngine` passe par `RISK_CHECKING`, appelle le
   service de risque déterministe, persiste un rapport `ALLOW`, puis enregistre
   `riskReportId` dans la session.
6. `EntryAmountService` calcule un montant admissible en `bigint`.
7. `TradeExecutor`, explicitement construit avec le mode `dry-run`, obtient une
   quote déterministe et persiste un achat `SIMULATED`. Il ne crée aucune
   transaction enfant on-chain.
8. Les achats confirmés suivants sont ingérés. Un hash déjà compté est ignoré.
9. Au seuil de sortie, le chemin de compatibilité existant sans
   `PositionExitEngineDependencies` appelle la vente dry-run et persiste un
   trade `SELL` `SIMULATED`.
10. La session termine en `CLOSED` et chaque événement consommé termine en
    `PROCESSED` avec `session_before` et `session_after`.

Le test configure explicitement ses variables avant les imports dynamiques :
`EXECUTION_MODE=dry-run`, `RISK_POLICY=allow-only`, seuils d’observation et de
sortie réduits, et URLs RPC loopback non utilisées. Il vérifie aussi que
`.env.example` conserve `EXECUTION_MODE=dry-run`.

## Déduplication et concurrence

### Rejeu d’un événement

Après le parcours principal, le même log `Swap` est présenté une seconde fois.
L’identifiant existant dérivé de la paire, du hash de transaction et du log
index doit conduire `SwapEventRepository.claim` à retourner `false`. Les
compteurs, la session et le nombre de trades restent inchangés.

Ce test doit échouer si la clause de claim idempotente ou l’identité du log est
supprimée.

### Double vente

Un second cas crée une session `HOLDING` persistée et lance simultanément deux
appels `sellManually` avec deux snapshots de la même paire. Le verrou par paire
de `SessionEngine` sérialise les opérations. Le premier appel ferme la position ;
le second recharge l’état `CLOSED` et échoue avec « Aucune position ouverte à
vendre ». PostgreSQL ne contient qu’un trade `SELL`.

Ce test doit échouer si le verrou ou le rechargement de la session persistée est
retiré.

## Gestion des erreurs et nettoyage

- Une incohérence de block hash fait échouer la passe avant toute décision
  métier.
- Une erreur du lecteur de logs est propagée ; aucun checkpoint n’est inventé
  par le harness.
- Si le risque ne retourne pas `ALLOW` sous `allow-only`, aucune entrée n’est
  créée.
- Toute erreur pendant le scénario laisse le schéma isolé supprimable dans le
  `finally`.
- Les watchers, listeners et clients PostgreSQL sont fermés même si une
  assertion échoue.
- Les erreurs et fixtures ne contiennent ni URL distante ni secret.

## Preuves attendues

Le test principal vérifie au minimum :

- une ligne canonique dans `discovered_tokens` ;
- une session finale `CLOSED` avec `riskReportId`, entrée et sortie dry-run ;
- un `TokenRiskReport` `ALLOW` lié à l’événement déclencheur ;
- exactement un trade `BUY` et un trade `SELL`, tous deux `SIMULATED` ;
- zéro ligne dans `trade_transactions` ;
- tous les swaps uniques en `PROCESSED` et aucun événement dupliqué ;
- des montants sérialisés sans conversion en `number` ;
- aucune seconde vente sous concurrence.

## Validation

La PR doit passer :

```bash
npm run check
npm test
TEST_DATABASE_URL=postgresql://... npm run test:postgres
npm run build
```

La CI fusionnée par la PR #43 exécute déjà ces quatre niveaux avec PostgreSQL
16. Le nouveau scénario rejoint `test:postgres` et ne change pas le défaut
`dry-run`.

## Livrables

- service d’admission de paire extrait et câblé dans `app.ts` ;
- fixtures blockchain déterministes focalisées sur ce scénario ;
- test PostgreSQL E2E du parcours principal ;
- test PostgreSQL de double vente concurrente ;
- documentation README des niveaux de test et de leur séparation ;
- PR liée à #12, sans fermer l’issue tant que chaîne locale/SafetyProbe et
  testnet opt-in ne sont pas terminés.
