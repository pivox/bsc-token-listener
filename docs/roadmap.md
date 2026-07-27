# Roadmap avant production

1. Réconciliation automatique des statuts `BUY_PENDING` et `SELL_PENDING` par wallet, reçu et nonce.
2. Gestion explicite des réorganisations et logs `removed`.
3. Mesure de la taxe réelle reçue à l’entrée et de l’impact prix.
4. Sorties de secours : durée maximale, perte maximale, liquidité retirée.
5. Alertes externes et métriques Prometheus.
6. Limitation globale du capital engagé et budget gas.
7. Tests d’intégration sur fork BSC avec tokens normaux, taxés et honeypots de test.
8. Support optionnel PancakeSwap V3/Infinity dans des modules séparés.
9. Détection de launchpads/factories connus et traces `CREATE`/`CREATE2`.
10. Double provider indépendant, avec bascule active des souscriptions et mesure de divergence.
