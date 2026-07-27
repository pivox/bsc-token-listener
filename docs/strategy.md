# Stratégie V1

## Définition d’un achat

Pour une paire V2 :

- WBNB entre dans la paire ;
- le nouveau token sort de la paire.

La logique tient compte de l’orientation WBNB en `token0` ou `token1`.

## Entrée

Le premier Swap classé `BUY` observé sur une paire créée depuis le démarrage déclenche les contrôles. En live, l’ordre est envoyé seulement après :

1. interface BEP-20 lisible ;
2. supply non nulle ;
3. liquidité WBNB minimale ;
4. sonde aller-retour réussie et perte sous le seuil.

L’entrée est basée sur un log confirmé : elle n’est pas garantie dans le même bloc. Une session encore en attente est expirée au redémarrage, afin de ne pas transformer un achat ancien en faux « premier achat ».

## Compteur de sortie

Après confirmation de notre entrée — ou, en `dry-run`, après un curseur virtuel placé à la fin du bloc courant — :

- ignorer tout événement antérieur ou égal au curseur d’entrée ;
- ignorer le hash de notre transaction ;
- compter une seule fois chaque hash de transaction d’achat ;
- vendre lorsque le compteur atteint `TARGET_BUYS_AFTER_ENTRY`.

Une vente échouée avant diffusion, ou révoquée avec certitude, remet la session en `HOLDING`; un Swap suivant provoque une nouvelle tentative. Si une vente a été diffusée mais que son résultat est ambigu, la session passe en `ERROR` pour empêcher une double vente et imposer une vérification du reçu/wallet.
