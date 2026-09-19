import { z } from 'zod';

export const IntentSchema = z.object({
  intent: z.enum([
    'prix_et_disponibilite',
    'rupture_de_stock',
    'conseil_taille',
    'negociation',
    'question_arabe',
    'client_qui_revient',
    'changement_avis',
    'note_vocale',
    'photo_produit',
    'suivi_commande',
    'retour_produit',
    'hors_domaine',
    'livraison_arabe',
    'rupture_arabe',
    'reclamation_arabe',
    'panier_abandonne',
    'darija_prix',
    'out_of_scope',
  ]),
  confidence: z.number().min(0).max(1).default(0.9),
});

export const EscalationSchema = z.object({
  escalate: z.boolean(),
  reason: z.string().min(1).max(200),
  category: z.enum([
    'hors_domaine',
    'remise_sous_plancher',
    'reclamation',
    'client_mecontent',
    'demande_humain',
    'autre',
  ]),
});

export const RelanceSchema = z.object({
  relancer: z.boolean(),
  delai_heures: z.number().int().min(1).max(72),
  angle: z.string().min(1).max(200),
});

export const LanguageSchema = z.object({
  language: z.enum(['fr', 'ar', 'darija']),
});