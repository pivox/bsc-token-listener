# TokenRiskReport

Le rapport est calculé après le premier achat observé et avant toute entrée du bot.

## Verdicts

- `ALLOW` : aucun échec, aucun avertissement et score supérieur ou égal au seuil.
- `REVIEW` : contrôle inconnu, avertissement ou score inférieur au seuil sans échec critique.
- `BLOCK` : échec critique ou score inférieur à 40.

## Contrôles critiques

- bytecode présent ;
- métadonnées BEP-20 minimales ;
- liquidité WBNB minimale ;
- simulation achat/revente réussie si `RISK_PROBE_REQUIRED=true` ;
- taxes et perte aller-retour sous les seuils configurés.

## Contrôles d'avertissement

- propriétaire actif ;
- proxy détecté ;
- fonctions sensibles visibles dans le bytecode ;
- LP non prouvée comme brûlée.

## Persistance

Chaque analyse est immuable dans `token_risk_reports`. La session conserve uniquement `riskReportId` afin de relier la décision au rapport utilisé au moment de l'entrée.
