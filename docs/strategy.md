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

## Continuité canonique et reorgs

Les WebSockets servent uniquement de signal de réveil : les logs et les headers sont toujours relus par RPC HTTP avant traitement. Avec `BLOCK_CONFIRMATIONS=5`, chaque décision suit donc la tête réseau d’au moins cinq blocs. Le journal canonique conserve une fenêtre de 128 blocs : un reorg récent est automatiquement rembobiné puis rejoué depuis son ancêtre commun ; un reorg plus profond suspend les passes et place les conséquences wallet en `MANUAL_REVIEW`.

Le heartbeat et le dashboard exposent la profondeur de confirmation, le head confirmé, le tip/hash canonique, l’état `HEALTHY`, `RECONCILING` ou `MANUAL_REVIEW`, et le dernier reorg (détection, ancêtre, profondeur et compteurs). Une erreur RPC conserve les dernières valeurs validées mais les marque `STALE` et ne présente jamais cet état comme `HEALTHY`.

## Surveillance continue et règles de sortie

Après confirmation de notre entrée — ou, en `dry-run`, après un curseur virtuel placé à la fin du bloc courant — :

- ignorer tout événement antérieur ou égal au curseur d’entrée ;
- ignorer le hash de notre transaction ;
- compter une seule fois chaque hash de transaction d’achat ;
- vendre lorsque le compteur atteint `TARGET_BUYS_AFTER_ENTRY`.

Le compteur n’est qu’une règle parmi les sorties continues. Par défaut, le
monitor s’exécute toutes les 15 secondes et applique, dans cet ordre :

1. probe inconnu ou bloqué : `MANUAL_REVIEW`, sans transaction ;
2. baisse de liquidité WBNB de 20 % : vente d’urgence seulement après un probe
   immédiat réussi ;
3. stop-loss économique de 10 % ;
4. durée maximale de 30 minutes ;
5. trailing stop éventuel ;
6. take-profit fixe de 20 % ;
7. compteur `TARGET_BUYS_AFTER_ENTRY`.

Tous les montants restent en entiers wei. La valeur économique est calculée
ainsi :

```text
entryCostWei = principal d’entrée + gas d’entrée confirmé
afterTaxWei = quoteWei × (10000 - sellTaxBps) / 10000
afterBufferWei = afterTaxWei × (10000 - quoteBufferBps) / 10000
netExitWei = max(0, afterBufferWei - gas de sortie estimé)
```

Une sortie normale est placée en `MANUAL_REVIEW` lorsque le gas estimé dépasse
10 % de `netExitWei`. Une urgence de liquidité ignore ce ratio, mais ne peut
jamais dépasser le plafond absolu de 0,01 BNB de gas.

Le trailing est désactivé par défaut. Lorsqu’il est activé, un gain de 20 %
arme le mécanisme et remplace la vente take-profit fixe ; un recul de 5 % par
rapport au pic net persistant déclenche ensuite la vente.

Les réglages effectifs, leur révision, la liquidité de référence, le pic
trailing et les décisions sont persistés. Après un crash, les transactions
existantes sont d’abord retrouvées par hash et nonce. Une décision
`EXECUTING` ne rediffuse jamais une transaction avant cette réconciliation.
Les listeners et le monitor de sortie ne démarrent qu’après la première
réconciliation canonique.

Une vente échouée avant diffusion, ou révoquée avec certitude, peut revenir en
`HOLDING`. Si une vente a été diffusée mais que son résultat est ambigu, la
référence de reprise reste persistée et la session exige une intervention
manuelle afin d’empêcher une double vente.
