# Smoke testnet BSC en lecture seule — conception

## Objectif

Ajouter un scénario manuel et explicitement opt-in qui exécute le vrai cœur du `SafetyProbe` sur BSC testnet au moyen d'un unique `eth_call`. Le scénario apporte une validation externe complémentaire à la chaîne EVM locale sans pouvoir signer, diffuser ou envoyer une transaction.

## Garde-fous

- `BSC_NETWORK` doit valoir `testnet`.
- `EXECUTION_MODE` doit valoir `dry-run`.
- `CONFIRM_TESTNET_PROBE` doit valoir exactement `I_UNDERSTAND_READ_ONLY_TESTNET`.
- `PRIVATE_KEY` doit être absente ou vide. Sa présence fait échouer le scénario avant tout appel RPC.
- Le client doit annoncer le chain ID `97` avant toute simulation.
- Le probe, le routeur et le token doivent avoir du bytecode.
- Le compte appelant doit avoir un solde au moins égal au montant simulé, car `eth_call` valide la valeur et le contexte du compte sans la dépenser.
- Le script n'importe et ne construit aucun wallet client et n'appelle aucune primitive de transaction.
- Le scénario ne s'exécute ni dans `npm test` ni dans la CI. Il reste une commande manuelle séparée.

## Architecture

Le calcul et l'appel explicites du probe sont déplacés dans un module sans configuration globale. `SafetyProbeService` conserve son interface actuelle et délègue à ce cœur, afin que le bot et le smoke testnet exercent exactement la même logique de simulation et de calcul des pertes en points de base.

Le script testnet possède son propre parseur d'environnement minimal. Il ne charge pas `src/config/env.ts` ni `src/rpc/clients.ts`, ce qui empêche toute dépendance implicite à une clé privée ou à la configuration complète de l'application.

Le flot est le suivant : validation locale de la configuration, création d'un `PublicClient` HTTP, vérification du chain ID, préflight bytecode/solde/bloc, puis simulation du probe. Le rapport JSON ne contient jamais l'URL RPC et convertit tous les `bigint` en chaînes.

## Variables manuelles

- `BSC_NETWORK=testnet`
- `EXECUTION_MODE=dry-run`
- `BSC_HTTP_RPC_URL`
- `SAFETY_PROBE_ADDRESS`
- `RISK_PROBE_CALLER`
- `PANCAKE_ROUTER_ADDRESS`
- `TESTNET_PROBE_TOKEN_ADDRESS`
- `RISK_PROBE_AMOUNT_BNB` (défaut `0.005`)
- `CONFIRM_TESTNET_PROBE=I_UNDERSTAND_READ_ONLY_TESTNET`

## Validation

Les tests unitaires couvrent les refus de confirmation, réseau, mode live et clé privée, l'ordre fail-closed avant simulation, les préflights et la forme du rapport. Un invariant source interdit les API viem de wallet et de transaction dans le script, et vérifie que la commande testnet n'est pas appelée par la CI.

