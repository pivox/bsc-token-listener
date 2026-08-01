# PostgreSQL CI Design

## Objectif

Faire exécuter les tests d’intégration PostgreSQL par GitHub Actions afin que
les migrations, leur idempotence et les invariants transactionnels soient
validés sur chaque push et pull request.

Ce lot couvre uniquement l’intégration PostgreSQL en CI et sa documentation.
Les scénarios sur chaîne locale, fork ou testnet restent dans les lots suivants
de l’issue GitHub #12.

## Architecture retenue

Le job GitHub Actions `validate` existant reste l’unique contrôle obligatoire.
Il démarre un service jetable `postgres:16-alpine`, attend sa disponibilité avec
`pg_isready`, puis transmet une URL dédiée par `TEST_DATABASE_URL` à la suite
`npm run test:postgres`.

Les identifiants PostgreSQL sont des valeurs de test statiques limitées au
conteneur éphémère de la CI. Aucun secret, endpoint externe ou accès à une base
persistante n’est utilisé.

Le job utilise `npm ci` et exécute, dans cet ordre :

1. `npm run check` ;
2. `npm test` ;
3. `npm run test:postgres` ;
4. `npm run build`.

Conserver un seul job évite de dupliquer l’installation Node et garantit qu’un
statut CI unique couvre typage, tests standards, intégration SQL et build.

## Données et isolation

Les tests PostgreSQL existants créent des schémas temporaires propres à chaque
scénario. Ils appliquent les migrations depuis une base vide, les rejouent pour
vérifier leur idempotence, valident les contraintes métier, puis suppriment les
schémas temporaires.

Le service PostgreSQL ne publie que le port local du runner nécessaire au job.
Il est détruit avec le runner GitHub Actions. La configuration de production et
le fichier `.env` local ne sont jamais lus.

## Gestion des erreurs

- Un service PostgreSQL non sain empêche le job de commencer les validations.
- Une migration non idempotente ou une contrainte SQL cassée fait échouer
  `npm run test:postgres` et donc le job entier.
- Les commandes suivantes ne masquent pas cet échec.
- Les timeouts du healthcheck restent bornés pour éviter un job bloqué.

## Documentation

Le README distingue explicitement :

- la suite standard sans PostgreSQL ;
- la préparation locale de PostgreSQL et `TEST_DATABASE_URL` ;
- l’exécution automatique de la suite PostgreSQL dans GitHub Actions.

La documentation conserve des identifiants locaux de démonstration et ne
contient aucun secret réel.

## Validation

Avant livraison :

- exécuter `npm run check` ;
- exécuter `npm test` ;
- exécuter `npm run test:postgres` contre PostgreSQL 16 ;
- exécuter `npm run build` ;
- vérifier le diff et la syntaxe du workflow GitHub Actions.

Le changement est accepté lorsque les quatre commandes réussissent et que la
CI lance effectivement la suite PostgreSQL sur les événements `push` et
`pull_request` existants.
