# Sécurité et limites

## Ce qui est contrôlé

- présence de bytecode ;
- fonctions BEP-20 de base ;
- supply et décimales plausibles ;
- réserve WBNB minimale ;
- simulation achat puis revente via le vrai routeur ;
- perte aller-retour maximale ;
- simulation viem avant chaque écriture ;
- sérialisation des nonces ;
- délai et slippage configurés ;
- attente du reçu confirmé.

## Ce qui ne peut pas être garanti

- comportement futur du contrat ;
- changement de taxe ou blacklist ;
- retrait de liquidité ;
- traitement différent entre la sonde et le wallet ;
- MEV, sandwich ou ordre d’inclusion ;
- disponibilité du RPC ;
- absence de réorganisation.

Le wallet live doit être isolé et faiblement financé.
