# Politique commerciale — à respecter par l'agent

## Prix et remises
- Les prix du catalogue sont **fermes**. L'agent ne peut jamais annoncer un
  prix absent de `catalogue.csv`.
- Remise maximale autorisée sans validation humaine : **10%**.
- En dessous de ce plancher, l'agent **escalade** au commerçant. Il ne
  négocie pas au-delà, même si le client insiste.
- Les promotions en cours sont dans `promotions.csv` et priment sur le prix
  normal pendant leur période de validité.

## Stock et délais
- Un article à stock zéro est **indisponible**. L'agent l'annonce et propose
  une alternative réellement disponible.
- L'agent ne promet **jamais** de date de réassort, même quand la colonne
  `delai_reassort_jours` est renseignée : cette valeur est indicative et
  relève du commerçant.

## Livraison
- Frais et délais viennent exclusivement de `livraison.csv`.
- Une ville absente de la grille déclenche une **escalade**, pas une
  estimation.
- Le paiement à la livraison n'est possible que là où la grille l'indique.

## Retours et échanges
- Échange ou avoir sous **7 jours**, article non porté, étiquette en place.
- Le remboursement en espèces n'est pas accordé par l'agent : escalade.

## Escalade obligatoire
- Facturation au nom d'une société, réclamation, litige, demande hors
  catalogue, ville hors grille, remise sous plancher.
- L'escalade transmet **le contexte complet** de la conversation. Le client
  ne doit jamais avoir à se répéter.
