# Plan d'implémentation — smoke SafetyProbe BSC testnet

## 1. Écrire les tests fail-closed

- Ajouter `tests/testnet-safety-probe.test.ts`.
- Tester le parseur d'environnement : configuration valide, confirmation absente, réseau non-testnet, mode non-dry-run, clé privée présente, URL ou adresse invalide.
- Tester le runner avec un client simulé : chain ID incorrect avant les autres lectures, bytecode absent, solde insuffisant, succès et rapport sérialisable.
- Ajouter un invariant source interdisant les primitives wallet/transaction et toute invocation depuis la CI.
- Lancer ce test seul et confirmer l'échec initial dû au module absent.

## 2. Extraire le cœur explicite du SafetyProbe

- Ajouter `src/security/safety-probe.client.ts` avec les types, le calcul des pertes et la fonction de simulation explicite.
- Faire déléguer `SafetyProbeService.probe()` à cette fonction sans modifier ses valeurs par défaut ni son API publique.
- Exécuter les tests SafetyProbe locaux pour prévenir toute régression.

## 3. Implémenter le scénario testnet

- Ajouter `scripts/check-testnet-safety-probe.ts` avec un parseur isolé, un runner fail-closed, un délai maximal et une sortie JSON nettoyée.
- Construire uniquement un `PublicClient` viem avec `bscTestnet` et un transport HTTP.
- Ajouter `npm run test:testnet`, sans l'inclure dans `npm test` ou la CI.
- Faire passer le test ciblé.

## 4. Documenter l'opt-in

- Ajouter un bloc commenté dans `.env.example`.
- Documenter dans `README.md` la commande, les préconditions, l'absence de clé privée et le fait qu'aucune transaction n'est envoyée.

## 5. Vérifier et livrer

- Lancer `npm run check`, `npm test` et `npm run build`.
- Examiner le diff et confirmer que la CI ne déclenche pas la commande externe.
- Committer, pousser, ouvrir une PR, demander une revue, traiter les remarques puis fusionner si tous les contrôles sont verts.
