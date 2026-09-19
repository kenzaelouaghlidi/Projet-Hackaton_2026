import dotenv from 'dotenv';
dotenv.config();

import { db } from './db';
import { reason, execute, classifyIntent, detectLanguage } from './llm';
import {
  searchProduct,
  checkStock,
  calculateDelivery,
  calculateCartTotal,
  createOrder,
  verifyDiscountEligibility,
  createEscalation,
  getOrCreateCustomer,
  getClientHistory,
  searchPolicies,
  DISCOUNT_FLOOR,
} from './tools';
import { EscalationSchema, RelanceSchema } from './schemas';

// ═══════════════════════════════════════════════════════════════
// ÉTAT PARTAGÉ ENTRE AGENTS
// ═══════════════════════════════════════════════════════════════
export interface KenzaState {
  request_id: string;
  client_id: string;
  conversation_id: string | null;
  raw_input: string;
  language: string;
  intent: string;
  intent_confidence: number;
  client_memory: any;
  cart: any;
  catalogue_results: any[];
  stock_status: any;
  delivery_estimate: any;
  order_created: any;
  guardrail_violations: string[];
  needs_human_review: boolean;
  escalation_reasons: string[];
  graph_trace: string[];
  tool_calls: any[];
  errors: string[];
  response: string;
}

export function makeInitialState(
  clientId: string,
  rawInput: string,
  conversationId: string | null = null
): KenzaState {
  return {
    request_id: `REQ-${Date.now()}`,
    client_id: clientId,
    conversation_id: conversationId,
    raw_input: rawInput,
    language: 'fr',
    intent: 'out_of_scope',
    intent_confidence: 0,
    client_memory: {},
    cart: { items: [], subtotal: 0, delivery_cost: 0, total: 0 },
    catalogue_results: [],
    stock_status: {},
    delivery_estimate: {},
    order_created: null,
    guardrail_violations: [],
    needs_human_review: false,
    escalation_reasons: [],
    graph_trace: [],
    tool_calls: [],
    errors: [],
    response: '',
  };
}

// ═══════════════════════════════════════════════════════════════
// AGENT 1 — CONVERSATION
// ═══════════════════════════════════════════════════════════════
export async function conversationAgent(
  state: KenzaState,
  userMessage: string
): Promise<{ response: string; intent: string; language: string }> {
  state.graph_trace.push('agent_conversation');

  const lang = await detectLanguage(userMessage);
  state.language = lang.trim().toLowerCase();

  const intent = await classifyIntent(userMessage);
  state.intent = intent.trim();

  const memory = await getClientHistory(state.client_id, 3);
  state.client_memory = memory;

  let memoryContext = 'Nouveau client.';
  if (memory.client) {
    const lastOrders = memory.recent_orders
      .map(
        (o: any) =>
          `- ${o.commande_id} (${o.date}, ${o.statut}, ${o.total_mad} MAD)`
      )
      .join('\n');
    memoryContext = `Client: ${memory.client.nom} (${memory.client.ville}, segment ${memory.client.segment})
Dernières commandes:
${lastOrders || 'Aucune'}`;
  }

  const systemPrompt = buildSystemPrompt(state.language, memoryContext);
  const response = await execute(systemPrompt, userMessage, { maxTokens: 500 });

  state.response = response;
  return { response, intent: state.intent, language: state.language };
}

export function buildSystemPrompt(language: string, memory: string): string {
  const base = `Tu es Kenza, agent commercial WhatsApp pour une boutique marocaine.

RÈGLES ABSOLUES :
- Ne JAMAIS inventer un prix, un stock ou un délai.
- Utilise UNIQUEMENT les données du catalogue qui te sont fournies ci-dessous.
- Si tu n'as pas l'information, dis-le et propose d'escalader.
- Remise maximale : 10% (plancher infranchissable).
- Si rupture de stock → propose une alternative RÉELLE disponible.
- Ne promets JAMAIS de date de réassort.
- N'invente AUCUN prix. Utilise EXACTEMENT les prix listés.

MÉMOIRE CLIENT :
${memory}`;

  if (language === 'darija') {
    return `${base}

LANGUE : darija (arabe marocain en lettres latines).
Exemples darija :
- "chhal taman ?" = combien le prix ?
- "bghit ncommandi" = je veux commander
- "wach kayn f stock ?" = est-ce en stock ?
- "3tini remise" = donne-moi une remise
- "wa n3tik" = je valide

Réponds en 1-3 phrases max, chaleureux et direct.
Utilise les prix EXACTS donnés dans DONNÉES CATALOGUE ci-dessous.`;
  }

  if (language === 'ar') {
    return `${base}

LANGUE : arabe standard moderne (فصحى).
Réponds en 1-3 phrases max.
Utilise les prix EXACTS donnés dans les DONNÉES CATALOGUE.`;
  }

  return `${base}

LANGUE : français.
Réponds en 1-3 phrases max, chaleureux et direct.
Utilise les prix EXACTS donnés dans les DONNÉES CATALOGUE.`;
}

// ═══════════════════════════════════════════════════════════════
// AGENT 2 — CATALOGUE
// ═══════════════════════════════════════════════════════════════
export async function catalogueAgent(
  state: KenzaState,
  action: 'search' | 'stock' | 'delivery' | 'cart_total' | 'order',
  params: Record<string, any>
): Promise<{ result: any; toolCall: any }> {
  state.graph_trace.push(`agent_catalogue_${action}`);
  const timestamp = new Date().toISOString();
  let result: any;

  switch (action) {
    case 'search':
      result = await searchProduct(params.query, params.limit || 5);
      break;
    case 'stock':
      result = await checkStock(params.ref);
      break;
    case 'delivery':
      result = await calculateDelivery(params.city);
      break;
    case 'cart_total':
      result = await calculateCartTotal(
        params.items,
        params.city,
        params.discountCode || ''
      );
      break;
    case 'order':
      result = await createOrder(
        params.clientId,
        params.items,
        params.deliveryCost,
        params.discount,
        params.villeLivraison,
        params.paiement
      );
      break;
  }

  const toolCall = { name: action, args: params, result, timestamp };
  state.tool_calls.push(toolCall);

  return { result, toolCall };
}

// ═══════════════════════════════════════════════════════════════
// AGENT 3 — GARDE-FOU (déterministe, corrigé)
// ═══════════════════════════════════════════════════════════════
export function guardrailAgent(
  state: KenzaState,
  proposedResponse: string,
  toolResults: any[]
): { valid: boolean; violations: string[] } {
  state.graph_trace.push('agent_guardrail');
  const violations: string[] = [];

  // 1. Vérifier les prix (tolérance 5%)
  const pricePattern = /(\d{2,6})\s*(?:MAD|dh|dirham)/gi;
  const pricesInResponse: number[] = [];
  let match;
  while ((match = pricePattern.exec(proposedResponse)) !== null) {
    pricesInResponse.push(parseInt(match[1]));
  }

  const toolJson = JSON.stringify(toolResults);
  const pricesInTools: number[] = [];
  const toolPattern = /(\d{2,6})/g;
  let toolMatch;
  while ((toolMatch = toolPattern.exec(toolJson)) !== null) {
    pricesInTools.push(parseInt(toolMatch[1]));
  }

  for (const price of pricesInResponse) {
    if (price < 50 || price > 100000) continue;
    const found = pricesInTools.some(
      (p) => Math.abs(p - price) <= Math.max(price * 0.05, 5)
    );
    if (!found) {
      violations.push(`Prix suspect: ${price} MAD (absent du catalogue)`);
    }
  }

  // 2. Vérifier le plancher de remise
  const discountMatch = proposedResponse.match(/(\d+)\s*%/);
  if (discountMatch && parseInt(discountMatch[1]) > DISCOUNT_FLOOR * 100) {
    violations.push(
      `Remise > ${DISCOUNT_FLOOR * 100}% interdite (détecté: ${discountMatch[1]}%)`
    );
  }

  // 3. Vérifier qu'aucun délai de réassort n'est promis
  const reassortPattern = /(réassort|restock|recevrai|disponible dans)\s+(\d+)/i;
  if (reassortPattern.test(proposedResponse)) {
    violations.push('Délai de réassort promis (interdit)');
  }

  state.guardrail_violations = violations;
  return { valid: violations.length === 0, violations };
}

// ═══════════════════════════════════════════════════════════════
// AGENT 4 — ESCALADE (GPT-5.5)
// ═══════════════════════════════════════════════════════════════
export async function escalationAgent(
  state: KenzaState,
  userMessage: string
): Promise<{ shouldEscalate: boolean; reason: string }> {
  state.graph_trace.push('agent_escalation');

  const systemPrompt = `Tu détectes si une demande doit être escaladée à un humain.

Escalade SI :
- Question hors domaine (facture société, réclamation, remboursement)
- Demande de remise > 10%
- Client mécontent ou agressif
- Ville hors grille de livraison
- Demande explicite d'un humain
- Litige en cours

Réponds UNIQUEMENT en JSON : {"escalate": true/false, "reason": "...", "category": "hors_domaine|remise_sous_plancher|reclamation|client_mecontent|demande_humain|autre"}`;

  const response = await reason(systemPrompt, userMessage, {
    maxTokens: 150,
    json: true,
  });

  try {
    const parsed = EscalationSchema.parse(JSON.parse(response));

    if (parsed.escalate) {
      state.needs_human_review = true;
      state.escalation_reasons.push(parsed.reason);

      await createEscalation(
        state.conversation_id,
        state.client_id,
        parsed.category,
        { reason: parsed.reason, message: userMessage }
      );
    }

    return { shouldEscalate: parsed.escalate, reason: parsed.reason };
  } catch (e) {
    state.errors.push(`Escalation parse error: ${e}`);
    return { shouldEscalate: false, reason: '' };
  }
}

// ═══════════════════════════════════════════════════════════════
// AGENT 5 — RELANCE (GPT-5.5)
// ═══════════════════════════════════════════════════════════════
export async function relanceAgent(
  cartSnapshot: any,
  customer: any
): Promise<{ message: string; delai_heures: number; angle: string } | null> {
  const decisionPrompt = `Tu décides si un panier abandonné mérite une relance.

Critères :
- Valeur du panier > 200 MAD
- Client actif récemment
- Pas déjà relancé 3 fois

Réponds JSON : {"relancer": true/false, "delai_heures": 24, "angle": "..."}`;

  const decision = await reason(
    decisionPrompt,
    JSON.stringify({ cartSnapshot, customer }),
    { maxTokens: 150, json: true }
  );

  const parsed = RelanceSchema.parse(JSON.parse(decision));
  if (!parsed.relancer) return null;

  const message = await execute(
    `Rédige un message de relance WhatsApp en darija, chaleureux et concis.
     Maximum 2 phrases. Rappelle le produit, propose de finaliser.`,
    `Panier : ${JSON.stringify(cartSnapshot)}\nAngle : ${parsed.angle}`,
    { maxTokens: 200 }
  );

  return {
    message,
    delai_heures: parsed.delai_heures,
    angle: parsed.angle,
  };
}

// ═══════════════════════════════════════════════════════════════
// ORCHESTRATEUR PRINCIPAL — ORDRE CORRIGÉ
// 1. Escalade → 2. Intention → 3. Catalogue → 4. Réponse enrichie → 5. Garde-fou
// ═══════════════════════════════════════════════════════════════
export async function orchestrateRequest(
  clientId: string,
  rawInput: string,
  conversationId: string | null = null
): Promise<KenzaState> {
  const state = makeInitialState(clientId, rawInput, conversationId);

  // 1. Charger/créer le client
  const customer = await getOrCreateCustomer(clientId);
  state.client_id = customer.client_id;

  // 2. Escalade (détection précoce)
  await escalationAgent(state, rawInput);

  // 3. Détection langue + intention
  state.graph_trace.push('agent_conversation_intent');
  const lang = await detectLanguage(rawInput);
  state.language = lang.trim().toLowerCase();
  const intent = await classifyIntent(rawInput);
  state.intent = intent.trim();

  // 4. Charger la mémoire client
  const memory = await getClientHistory(state.client_id, 3);
  state.client_memory = memory;

  // 5. CATALOGUE — chercher AVANT de générer la réponse
  if (
    [
      'prix_et_disponibilite',
      'darija_prix',
      'rupture_de_stock',
      'conseil_taille',
    ].includes(state.intent)
  ) {
    const search = await catalogueAgent(state, 'search', {
      query: rawInput,
      limit: 5,
    });
    state.catalogue_results = search.result;

    if (search.result.length > 0) {
      const firstProduct = search.result[0];
      const stock = await catalogueAgent(state, 'stock', {
        ref: firstProduct.ref,
      });
      state.stock_status = stock.result;
    }
  }

  // 6. Négociation — vérifier le plancher
  if (state.intent === 'negociation') {
    const discountMatch = rawInput.match(/(\d+)\s*%/);
    const requested = discountMatch ? parseInt(discountMatch[1]) / 100 : 0;
    const elig = verifyDiscountEligibility(requested);
    if (elig.needs_human_review) {
      state.needs_human_review = true;
      state.escalation_reasons.push(...elig.rejection_reasons);
    }
  }

  // 7. GÉNÉRER LA RÉPONSE avec les données injectées
  state.graph_trace.push('agent_conversation_response');

  let memoryContext = 'Nouveau client.';
  if (memory.client) {
    const lastOrders = memory.recent_orders
      .map(
        (o: any) =>
          `- ${o.commande_id} (${o.date}, ${o.statut}, ${o.total_mad} MAD)`
      )
      .join('\n');
    memoryContext = `Client: ${memory.client.nom} (${memory.client.ville}, segment ${memory.client.segment})
Dernières commandes:
${lastOrders || 'Aucune'}`;
  }

  // Injecter les résultats du catalogue
  let catalogueContext = 'Aucun produit trouvé dans le catalogue.';
  if (state.catalogue_results.length > 0) {
    catalogueContext = state.catalogue_results
      .map(
        (p: any) =>
          `- REF ${p.ref} : ${p.modele} (${p.couleur || ''}, ${p.taille || ''}) — PRIX EXACT : ${p.prix_mad} MAD — stock: ${p.stock}`
      )
      .join('\n');
  }

  let stockContext = '';
  if (state.stock_status && state.stock_status.ref) {
    stockContext = `\nStock du produit demandé (${state.stock_status.ref}) : ${
      state.stock_status.available
        ? `disponible (${state.stock_status.quantity} unités)`
        : 'RUPTURE DE STOCK'
    }`;
    if (state.stock_status.substitutes?.length > 0) {
      stockContext += `\nSubstituts disponibles :\n${state.stock_status.substitutes
        .map(
          (s: any) =>
            `- ${s.ref} : ${s.modele} (${s.couleur || ''}) — ${s.prix_mad} MAD`
        )
        .join('\n')}`;
    }
  }

  const systemPrompt =
    buildSystemPrompt(state.language, memoryContext) +
    `\n\nDONNÉES CATALOGUE (utilise UNIQUEMENT ces données, ne JAMAIS inventer) :\n${catalogueContext}${stockContext}`;

  const response = await execute(systemPrompt, rawInput, { maxTokens: 500 });
  state.response = response;

  // 8. Garde-fou final
  const guardrail = guardrailAgent(state, response, state.tool_calls);
  if (!guardrail.valid) {
    state.needs_human_review = true;
    state.escalation_reasons.push(...guardrail.violations);
  }

  return state;
}