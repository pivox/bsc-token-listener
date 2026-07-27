# Validation de cette archive

Contrôles exécutés lors de la génération :

- compilation statique de l’ensemble des fichiers TypeScript avec `strict=true` ;
- compilation JavaScript de validation ;
- exécution de 15 tests unitaires : sérialisation `bigint`, calculs, classification BUY/SELL et machine d’état ;
- recherche de secrets et de fichiers temporaires avant création du ZIP.

Limites de l’environnement de génération :

- le registre npm n’était pas accessible, donc `npm install` et le contrôle contre les déclarations exactes de `viem@2.55.8` n’ont pas pu être exécutés ici ;
- Foundry/`forge` n’était pas installé, donc `contracts/SafetyProbe.sol` n’a pas été compilé dans cet environnement ;
- aucun ordre réel ni appel RPC live n’a été envoyé.

À exécuter localement avant tout démarrage :

```bash
npm install
npm run check
npm run rpc:check
forge build
```

Le mode `dry-run` doit rester actif pendant la phase de validation fonctionnelle.
