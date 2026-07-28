# Réconciliation des sessions et transactions après un crash

## Contexte

Le bot restaure actuellement les sessions actives depuis PostgreSQL, puis
redémarre directement leurs listeners. Les statuts `RISK_CHECKING`,
`BUY_PENDING`, `SELL_PENDING` et `MANUAL_REVIEW` ne disposent pas d'un workflow
de reprise explicite. Un crash peut donc laisser une intention métier et une
transaction on-chain dans des états différents.

L'issue #8 fournit désormais les fondations nécessaires : chaque étape on-chain
`BUY`, `APPROVE` ou `SELL` persiste son hash, son nonce, le wallet, ses soldes de
référence et son cycle de vie avant la diffusion. L'issue #7 doit exploiter ces
preuves sans jamais rediffuser une transaction ambiguë.

## Objectifs

- Réconcilier les sessions intermédiaires au démarrage avant tout listener.
- Répéter la réconciliation toutes les 30 secondes sans chevauchement.
- Reprendre automatiquement une intention déjà persistée lorsque l'absence de
  transaction enfant prouve qu'aucune diffusion n'a pu avoir lieu.
- Reconstruire une entrée ou une sortie à partir de PostgreSQL, du reçu et des
  soldes réels.
- Ne jamais rediffuser lorsque la présence d'un hash ou d'un nonce rend le
  résultat on-chain ambigu.
- Produire un diagnostic persistant et exploitable pour chaque cas non prouvable.
- Préserver l'idempotence après plusieurs redémarrages et entre plusieurs
  processus concurrents.

## Non-objectifs

- Activer automatiquement le mode live ou modifier ses confirmations.
- Stocker une transaction sérialisée, une clé privée ou une erreur RPC brute.
- Remplacer toute la stratégie par une machine événementielle.
- Ajouter de la haute disponibilité RPC, du mempool ou du front-running.
- Rediffuser une transaction existante, même si son reçu est momentanément
  introuvable.

## Architecture retenue

### `RecoveryCoordinator`

Le coordinateur impose la barrière de démarrage et pilote la boucle périodique.
Il :

1. obtient un verrou PostgreSQL global afin qu'un seul processus coordonne une
   passe ;
2. réclame les sessions réconciliables une par une ;
3. attend que chaque session ait reçu une décision ou un diagnostic ;
4. libère le verrou ;
5. autorise seulement alors le démarrage des listeners ;
6. relance la même passe toutes les 30 secondes.

Une passe périodique déjà en cours n'est jamais doublée. À l'arrêt, le timer est
stoppé avant les listeners et la connexion PostgreSQL.

### `SessionReconciler`

Le réconciliateur contient la machine de décision. Il dépend d'interfaces
étroites pour PostgreSQL, les lectures on-chain, l'analyse de risque et
l'exécution existante. Il ne reçoit aucun listener et ne traite aucun nouvel
événement blockchain.

Il peut demander au `SessionEngine` ou à une façade d'exécution dédiée de
continuer une intention prouvée sans transaction. Dès qu'une transaction enfant
existe, son travail devient strictement read-only vis-à-vis de la blockchain.

### `ReconciliationRepository`

Ce repository :

- prend le verrou global ;
- réclame une session avec un bail court ;
- charge atomiquement la session, ses trades et leurs transactions ;
- applique une décision uniquement si le bail et l'état attendu sont toujours
  valides ;
- met à jour ensemble la session, le trade, la transaction et l'audit.

Les appels RPC ne sont jamais effectués à l'intérieur d'une transaction SQL
longue.

### `ReconciliationGateway`

Cette interface viem, exclusivement en lecture, expose :

- la recherche d'un reçu par hash ;
- la recherche d'une transaction pending ou minée par hash ;
- le solde natif du wallet ;
- le solde token du wallet.

Elle distingue une absence RPC prouvée d'une erreur de transport. Ses erreurs
sont filtrées avant persistance ou journalisation.

## Modèle de persistance

Une migration SQL idempotente ajoute à `token_sessions` :

- `recovery_owner` ;
- `recovery_lease_until` ;
- `recovery_attempts`, avec zéro par défaut ;
- `recovery_error` ;
- `last_reconciled_at`.

Le payload JSON de la session reste la représentation métier. Les colonnes de
récupération servent aux réclamations concurrentes et au diagnostic
opérationnel.

Une table `reconciliation_decisions` contient :

- un identifiant ;
- une clé d'idempotence unique ;
- la paire et le token ;
- l'état avant et après ;
- l'action décidée ;
- le trade et le hash éventuels ;
- une raison filtrée ;
- la date de décision.

Seules les décisions significatives sont auditées. Un simple contrôle répété
d'une transaction encore pending met à jour le diagnostic de session sans
dupliquer l'audit.

## Protocole d'une réconciliation

1. Réclamer la session en définissant un propriétaire et une expiration de bail.
2. Charger un snapshot cohérent de la session et de son cycle de trade.
3. Déterminer les lectures RPC nécessaires.
4. Effectuer ces lectures hors transaction SQL.
5. Construire une décision pure.
6. Ouvrir une transaction SQL courte.
7. Vérifier le propriétaire du bail et l'état initial.
8. Appliquer la session, le trade, la transaction enfant et l'audit.
9. Libérer le bail.

Si le processus meurt, le bail expire naturellement. Si l'état change entre les
étapes 2 et 7, la décision obsolète est abandonnée sans écriture.

## Machine de décision

### `RISK_CHECKING`

- Reprendre l'analyse au bloc du premier achat persisté.
- Persister le `TokenRiskReport` avant toute transition d'entrée.
- Avec `RISK_POLICY=allow-only`, seul `ALLOW` peut continuer.
- `ALLOW` fait passer atomiquement la session à `BUY_PENDING`, puis reprend
  l'intention d'achat.
- `REVIEW` ou `BLOCK` produit `REJECTED`.
- Une erreur RPC conserve `RISK_CHECKING`, incrémente le diagnostic de reprise
  et sera retentée lors de la prochaine passe. Elle n'est jamais interprétée
  comme un rejet on-chain.

### `BUY_PENDING`

Le repository recherche le trade `BUY` rattaché à la paire et sa dernière
transaction enfant.

- Aucun trade, ou trade sans transaction enfant : aucune diffusion n'a pu être
  initiée, car l'exécuteur persiste la transaction enfant avant
  `sendRawTransaction`. Le trade incomplet est diagnostiqué et l'intention peut
  être reprise automatiquement après vérification d'un rapport `ALLOW`
  persisté.
- Transaction enfant existante : aucune rediffusion n'est autorisée.
- Reçu `success` : mesurer les soldes après exécution, finaliser le trade et
  construire `session.entry`, puis passer à `HOLDING`.
- Reçu `reverted` : finaliser le trade en `REVERTED` et passer la session à
  `REJECTED` avec la preuve.
- Transaction trouvée mais sans reçu : conserver `BUY_PENDING`, enregistrer
  `pending` et contrôler de nouveau lors de la prochaine passe.
- Hash absent du RPC ou erreur RPC : passer à `MANUAL_REVIEW`.
- Reçu confirmé mais soldes illisibles : passer à `MANUAL_REVIEW` avec une
  référence de réconciliation ; une passe ultérieure retentera uniquement les
  mesures.

### `SELL_PENDING`

- Aucun trade `SELL`, ou trade sans transaction enfant : reprendre
  automatiquement l'intention de vente.
- Transaction enfant existante : aucune rediffusion.
- Reçu `success` : mesurer les soldes, finaliser `session.exit` et passer à
  `CLOSED`.
- Reçu `reverted` : finaliser le trade en `REVERTED`, revenir à `HOLDING` avec
  un diagnostic et laisser le workflow normal décider d'une nouvelle tentative.
- Transaction trouvée mais sans reçu : conserver `SELL_PENDING` et réessayer la
  lecture lors de la prochaine passe.
- Hash absent ou erreur RPC : `MANUAL_REVIEW`.
- Reçu confirmé mais mesures indisponibles : `MANUAL_REVIEW`, sans nouvelle
  vente.

Une transaction `APPROVE` est réconciliée avant la transaction `SELL`. Un
approval confirmé autorise la poursuite de la vente seulement si aucune
transaction `SELL` n'existe. Un approval revert ou ambigu interdit la vente
automatique pendant cette passe.

### `MANUAL_REVIEW`

La reprise est strictement read-only sur la blockchain :

- une preuve d'achat réussi peut reconstruire l'entrée et produire `HOLDING` ;
- une preuve de vente réussie peut reconstruire la sortie et produire `CLOSED` ;
- un revert d'achat peut produire `REJECTED` ;
- un revert de vente peut produire `HOLDING` ;
- un état toujours non prouvable conserve `MANUAL_REVIEW` et actualise son
  diagnostic.

La réconciliation ne prépare et ne diffuse jamais une transaction depuis
`MANUAL_REVIEW`.

### `dry-run`

La même machine de sessions est utilisée sans lecture de reçu ni diffusion :

- une exécution `SIMULATED` déjà persistée reconstruit la session ;
- une intention sans exécution simulée peut être reprise ;
- plusieurs redémarrages produisent une seule entrée ou sortie métier ;
- aucun composant de récupération ne peut initialiser un wallet live.

## Reconstitution des montants

Les soldes `before` persistés par la transaction enfant restent la base de
calcul. Après un reçu réussi, le réconciliateur lit les soldes `after` et
réutilise les fonctions comptables de l'exécuteur :

- principal réel de l'achat ;
- quantité token réellement reçue ;
- quantité token réellement vendue ;
- produit natif réel de la vente ;
- coût du gas à partir du reçu ;
- cumul du gas d'approval et de vente.

Tous les montants restent des `bigint`. Une variation incohérente ne produit
jamais un montant estimé : elle entraîne `MANUAL_REVIEW`.

## Sécurité et observabilité

- `EXECUTION_MODE=dry-run` reste la valeur par défaut.
- Le live conserve `RISK_POLICY=allow-only` et ses confirmations existantes.
- Chaque reprise d'achat vérifie un `TokenRiskReport` persisté et `ALLOW`.
- Hash et nonce existants interdisent toute rediffusion automatique.
- Une erreur RPC n'est jamais assimilée à un revert.
- Les logs contiennent la paire, le token, le trade, le hash, l'état et une
  raison filtrée.
- Les transactions sérialisées, erreurs RPC brutes et secrets ne sont jamais
  persistés ni loggés.
- Le heartbeat et le dashboard pourront exposer le nombre de sessions en reprise
  et le dernier diagnostic sans rendre les actions dangereuses disponibles.

## Intégration au démarrage

Après les vérifications réseau et les migrations, l'application construit les
repositories et services, puis exécute la passe initiale. Aucun `SwapListener`
ni `PairCreatedListener` n'est démarré avant sa fin.

Les sessions devenues terminales ne reçoivent pas de moniteur. Les sessions
restant actives sont rechargées après la barrière afin que les listeners voient
leurs états réconciliés, et non les objets chargés avant la reprise.

La boucle de 30 secondes démarre après les listeners. Elle partage le même
verrou global et ne peut pas chevaucher la passe initiale ou une autre passe
périodique.

## Stratégie de tests

### Tests unitaires

- décision pour chaque statut et chaque résultat RPC ;
- reprise `RISK_CHECKING` avec rapport `ALLOW`, `REVIEW`, `BLOCK` et erreur RPC ;
- crash avant trade et après trade sans transaction enfant ;
- transaction enfant `CREATED`, `SUBMITTED`, `UNKNOWN` ou `CONFIRMED` ;
- reçu success, revert, pending, absent et erreur RPC ;
- reconstitution exacte des entrées, sorties et coûts de gas ;
- approval confirmé, revert et ambigu ;
- `MANUAL_REVIEW` strictement read-only ;
- dry-run idempotent ;
- diagnostics filtrés sans octets signés.

### Tests PostgreSQL

- migration exécutée deux fois ;
- acquisition et expiration du bail ;
- exclusion de deux réconciliateurs concurrents ;
- refus d'une décision dont le bail ou l'état est obsolète ;
- atomicité session, trade, transaction et audit ;
- unicité de la décision d'audit après plusieurs redémarrages.

### Tests d'intégration applicative

- aucun listener avant la fin de la passe initiale ;
- crash avant diffusion ;
- crash après diffusion avant reçu persisté ;
- redémarrages répétés sans double achat ni double vente ;
- boucle périodique non chevauchante ;
- arrêt propre du timer et expiration sûre d'un bail abandonné.

Les commandes obligatoires restent :

```bash
npm run check
npm test
npm run build
```

Le test PostgreSQL opt-in sera également exécuté sur une base PostgreSQL 16
fraîche.

## Documentation opérateur

Le README décrira :

- la barrière de réconciliation au démarrage ;
- la cadence de 30 secondes ;
- les transitions automatiques et les cas `MANUAL_REVIEW` ;
- la signification des diagnostics et des décisions d'audit ;
- la procédure de vérification d'un hash avant intervention humaine ;
- l'interdiction de rediffuser une transaction ambiguë.

## Critères de réussite

- Aucun listener ne démarre avant la décision initiale de reprise.
- Aucune transaction possédant un hash ou un nonce persisté n'est rediffusée.
- Une intention sans transaction enfant peut reprendre automatiquement avec ses
  garde-fous de risque.
- Les sessions intermédiaires obtiennent un état cohérent ou un diagnostic
  persistant.
- Les reçus et soldes reconstruisent les mêmes montants que l'exécution normale.
- Les reprises successives et concurrentes restent idempotentes.
- Les tests unitaires, PostgreSQL, typecheck et build passent.
