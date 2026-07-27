# AGENTS.md

## Mission du dépôt

Construire un listener/trader BSC déterministe et observable pour PancakeSwap V2 : entrée après le premier achat confirmé, puis sortie après N transactions d’achat uniques postérieures à notre entrée.

## Règles non négociables

- Conserver `EXECUTION_MODE=dry-run` par défaut.
- Ne jamais activer le live, réduire un contrôle de sécurité ou augmenter le montant sans demande explicite.
- Ne jamais écrire de clé privée, seed phrase, clé RPC ou secret dans le dépôt, les tests ou les logs.
- Utiliser `bigint` pour toute quantité on-chain. Aucun calcul monétaire en `number`.
- Une quantité en BNB/token doit rester en unité entière jusqu’à l’affichage.
- Les événements doivent être idempotents : identité `transactionHash:logIndex`.
- Les swaps doivent être traités séquentiellement par paire.
- Compter des hashes de transaction d’achat uniques, strictement après le curseur d’entrée.
- Exclure le déclencheur et la transaction d’entrée du compteur.
- Ne pas remplacer les logs confirmés par une logique mempool sans documenter le nouveau modèle de risque.
- Ne pas prétendre qu’une sonde garantit l’absence de honeypot ou de rug pull.

## Architecture

- `src/listeners`: acquisition des événements uniquement.
- `src/strategy`: classification et transitions métier, sans appels RPC directs.
- `src/security`: contrôles préalables, sans envoi de transactions.
- `src/execution`: simulation, signature, diffusion et lecture des reçus.
- `src/storage`: idempotence et reprise.
- `contracts/SafetyProbe.sol`: sonde qui doit toujours terminer par `ProbeResult`.

Ne pas mélanger stratégie et transport RPC.

## Commandes obligatoires avant de terminer une modification

```bash
npm run typecheck
npm test
```

Pour une modification Solidity :

```bash
forge build
```

Une tâche n’est terminée que si les commandes applicables passent ou si l’impossibilité est expliquée précisément.

## Conventions TypeScript

- TypeScript strict, ESM, imports locaux avec extension `.js`.
- Pas de `any` sauf frontière externe justifiée et isolée.
- Valider les valeurs RPC nullables avant usage.
- Préférer de petites classes à responsabilité unique.
- Les erreurs doivent contenir la paire/token concerné dans le log appelant, jamais un secret.
- Toute nouvelle transition de statut exige un test unitaire.
- Toute modification de la classification BUY/SELL exige des tests pour les deux orientations token0/token1.

## Revue de sécurité

Avant une modification d’exécution live, vérifier :

1. mode dry-run inchangé par défaut ;
2. simulation avant écriture ;
3. nonce sérialisé ;
4. délai de transaction ;
5. slippage explicite ;
6. reçu confirmé et statut `success` ;
7. idempotence après redémarrage ;
8. aucune donnée secrète journalisée.

## Portée actuelle

PancakeSwap V2, paire directe Token/WBNB. Ne pas annoncer le support V3, Infinity, multi-hop, mempool ou launchpads tant qu’il n’existe pas avec tests et documentation.
