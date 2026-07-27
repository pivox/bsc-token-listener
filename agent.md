# Consignes Codex CLI

## Objectif
Développer un bot BSC orienté observation et simulation. Le passage en argent réel doit rester explicitement verrouillé.

## Règles obligatoires
- TypeScript strict, ESM et viem.
- Ne jamais écrire de clé privée dans le code, les tests ou les logs.
- `EXECUTION_MODE=dry-run` reste la valeur par défaut.
- Toute entrée doit disposer d'un `TokenRiskReport` persisté avant exécution.
- En mode `RISK_POLICY=allow-only`, seuls les rapports `ALLOW` peuvent entrer.
- Toute évolution de sécurité ajoute ou met à jour des tests.
- Les migrations SQL doivent être idempotentes.
- Les événements blockchain doivent être dédupliqués par transaction + log index.
- Une erreur RPC ne doit jamais avancer un checkpoint.

## Validation avant commit
```bash
npm run check
npm test
npm run build
```

## Hors périmètre sans demande explicite
- mempool et front-running ;
- contournement de protections anti-bot ;
- stockage de secrets ;
- activation automatique du live.
