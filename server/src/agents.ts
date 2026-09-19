import dotenv from 'dotenv';
dotenv.config();

import { db } from './db';
import { reason, execute } from './llm';
import {
  searchProduct,
  getFamilyVariants,
  findVariants,
  getAllFamilies,
  checkStock,
  calculateDelivery,
  calculateCartTotal,
  createOrder,
  verifyDiscountEligibility,
  createEscalation,
  getOrCreateCustomer,
  getClientHistory,
  searchPolicies,
  getOrCreateConversation,
  appendMessage,
  getConversationHistory,
  DISCOUNT_FLOOR,
} from './tools';
import { EscalationSchema, RelanceSchema } from './schemas';
import {
  translateDarija,
  detectGenre,
  detectCity,
  detectLocation,
  detectColor,
  detectFamily,
  detectDeliveryIntent,
  detectNonCommercial,
  isTailleOnly,
  hasSizeSpecified,
  SIZE_LESS_FAMILIES,
} from './darija';

// ═══════════════════════════════════════════════════════════════
// ÉTAT PARTAGÉ
// ═══════════════════════════════════════════════════════════════
export interface KenzaState {
  request_id: string;
  client_id: string;
  conversation_id: string | null;
  raw_input: string;
  language: string;
  preferred_language: string;
  intent: string;
  intent_confidence: number;
  intent_reasoning: string;
  client_memory: any;
  conversation_history: any[];
  cart: any;
  current_product: any;
  current_family: string;
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
  conversationId: string | null = null,
  preferredLanguage: string = ''
): KenzaState {
  return {
    request_id: `REQ-${Date.now()}`,
    client_id: clientId,
    conversation_id: conversationId,
    raw_input: rawInput,
    language: 'fr',
    preferred_language: preferredLanguage,
    intent: 'unknown',
    intent_confidence: 0,
    intent_reasoning: '',
    client_memory: {},
    conversation_history: [],
    cart: { items: [], subtotal: 0, delivery_cost: 0, total: 0 },
    current_product: null,
    current_family: '',
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
// AGENT 0 — COMPRÉHENSION (GPT-5.5)
// ═══════════════════════════════════════════════════════════════
async function understandMessage(
  userMessage: string,
  clientMemory: any,
  history: any[]
): Promise<{
  language: string;
  intent: string;
  reasoning: string;
  needs_catalogue: boolean;
  needs_delivery: boolean;
  needs_clarification: boolean;
  city?: string;
  product_family?: string;
  size?: string;
  color?: string;
}> {
  const memoryContext = clientMemory?.client
    ? `Client: ${clientMemory.client.nom} (${clientMemory.client.ville})`
    : 'Nouveau client';

  const historyContext =
    history.length > 0
      ? `\n\nHISTORIQUE :\n${history
          .map((m: any) => `${m.role}: ${m.content}`)
          .join('\n')}\n\nUtilise cet historique pour comprendre le contexte.`
      : '';

  const systemPrompt = `Tu es un analyseur de messages client pour une boutique marocaine.

Ta mission : COMPRENDRE ce que le client veut VRAIMENT, en tenant compte du contexte.
${historyContext}

Réponds en JSON :
{
  "language": "fr" | "ar" | "darija",
  "intent": "<description courte>",
  "reasoning": "<raisonnement en 1-2 phrases>",
  "needs_catalogue": true | false,
  "needs_delivery": true | false,
  "needs_clarification": true | false,
  "city": "<nom de ville si mentionnée, sinon null>",
  "product_family": "<famille ou 'TOUT' ou null>",
  "size": "<taille ou null>",
  "color": "<couleur ou null>"
}

RÈGLES :
- Client demande prix/stock/produit → needs_catalogue: true
- Client parle de remise → needs_catalogue: true
- Client demande livraison OU mentionne une ville → needs_delivery: true
- Client dit "3tini ga3 li 3ndkom" → needs_catalogue: true + product_family: "TOUT"
- Client dit bonjour/merci/haha → needs_clarification: true

Villes : Casablanca, Rabat, Fès, Marrakech, Tanger, Agadir, Meknès, Oujda, Kénitra, Tétouan, Salé, Mohammedia.

CONTEXTE CLIENT : ${memoryContext}

Réponds UNIQUEMENT en JSON valide.`;

  const response = await reason(systemPrompt, userMessage, {
    maxTokens: 300,
    json: true,
  });

  try {
    const parsed = JSON.parse(response);
    return {
      language: parsed.language || 'darija',
      intent: parsed.intent || 'unknown',
      reasoning: parsed.reasoning || '',
      needs_catalogue: parsed.needs_catalogue === true,
      needs_delivery: parsed.needs_delivery === true,
      needs_clarification: parsed.needs_clarification === true,
      city: parsed.city || undefined,
      product_family: parsed.product_family || undefined,
      size: parsed.size || undefined,
      color: parsed.color || undefined,
    };
  } catch {
    return {
      language: 'darija',
      intent: 'unknown',
      reasoning: 'Parse error',
      needs_catalogue: false,
      needs_delivery: false,
      needs_clarification: true,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// AGENT 1 — CONVERSATION
// ═══════════════════════════════════════════════════════════════
export async function conversationAgent(
  state: KenzaState,
  userMessage: string,
  catalogueData?: string,
  stockData?: string
): Promise<string> {
  state.graph_trace.push('agent_conversation');

  let memoryContext = 'Nouveau client.';
  if (state.client_memory.client) {
    const lastOrders = state.client_memory.recent_orders
      .map(
        (o: any) =>
          `- ${o.commande_id} (${o.date}, ${o.statut}, ${o.total_mad} MAD)`
      )
      .join('\n');
    memoryContext = `Client: ${state.client_memory.client.nom} (${state.client_memory.client.ville}, segment ${state.client_memory.client.segment})
Dernières commandes:
${lastOrders || 'Aucune'}`;
  }

  let historyContext = '';
  if (state.conversation_history.length > 0) {
    historyContext = `\n\nHISTORIQUE RÉCENT :\n${state.conversation_history
      .slice(-5)
      .map((m: any) => `${m.role}: ${m.content}`)
      .join('\n')}`;
  }

  const systemPrompt =
    buildSystemPrompt(state.language, memoryContext, catalogueData, stockData) +
    historyContext;

  const response = await execute(systemPrompt, userMessage, { maxTokens: 500 });
  state.response = response;
  return response;
}

export function buildSystemPrompt(
  language: string,
  memory: string,
  catalogueData?: string,
  stockData?: string
): string {
  const base = `Tu es Kenza, une vendeuse sympa dans une boutique marocaine sur WhatsApp.

TON RÔLE :
- Tu es chaleureuse, naturelle, humaine.
- Tu réponds en darija, arabe ou français selon le client.
- Si le client rigole, tu ris avec lui.

RÈGLES STRICTES (TRÈS IMPORTANT) :
- Ne JAMAIS inventer un prix, un stock, une taille ou un délai.
- Utilise UNIQUEMENT les données du catalogue ci-dessous.
- Remise maximale : 10%.
- Si un produit n'existe PAS → dis-le honnêtement et propose UNIQUEMENT une alternative dans la MÊME famille.
- NE JAMAIS demander la taille si le produit n'existe PAS.
- Ne JAMAIS dire "je n'ai pas compris" si tu as des données du catalogue.

MÉMOIRE CLIENT :
${memory}`;

  const catalogueSection = catalogueData
    ? `\n\nDONNÉES CATALOGUE (utilise EXACTEMENT ces données) :\n${catalogueData}`
    : '';

  const stockSection = stockData ? `\n\nSTOCK : ${stockData}` : '';

  if (language === 'darija') {
    return `${base}${catalogueSection}${stockSection}

LANGUE : darija (arabe marocain en lettres latines).
Réponds en 1-3 phrases max, chaleureuse et directe.`;
  }

  if (language === 'ar') {
    return `${base}${catalogueSection}${stockSection}

LANGUE : arabe standard moderne.
Réponds en 1-3 phrases max.`;
  }

  return `${base}${catalogueSection}${stockSection}

LANGUE : français.
Réponds en 1-3 phrases max.`;
}

// ═══════════════════════════════════════════════════════════════
// AGENT 2 — CATALOGUE
// ═══════════════════════════════════════════════════════════════
export async function catalogueAgent(
  state: KenzaState,
  action: 'search' | 'stock' | 'delivery' | 'cart_total' | 'order' | 'variants' | 'families',
  params: Record<string, any>
): Promise<{ result: any; toolCall: any }> {
  state.graph_trace.push(`agent_catalogue_${action}`);
  const timestamp = new Date().toISOString();
  let result: any;

  switch (action) {
    case 'search':
      result = await searchProduct(params.query, params.limit || 30, params.genre, params.famille);
      break;
    case 'variants':
      result = await findVariants(params.famille, params.taille);
      break;
    case 'families':
      result = await getAllFamilies();
      break;
    case 'stock':
      result = await checkStock(params.ref);
      break;
    case 'delivery':
      result = await calculateDelivery(params.city);
      break;
    case 'cart_total':
      result = await calculateCartTotal(params.items, params.city, params.discountCode || '');
      break;
    case 'order':
      result = await createOrder(
        params.clientId, params.items, params.deliveryCost,
        params.discount, params.villeLivraison, params.paiement
      );
      break;
  }

  const toolCall = { name: action, args: params, result, timestamp };
  state.tool_calls.push(toolCall);

  return { result, toolCall };
}

// ═══════════════════════════════════════════════════════════════
// AGENT 3 — GARDE-FOU
// ═══════════════════════════════════════════════════════════════
export function guardrailAgent(
  state: KenzaState,
  proposedResponse: string,
  toolResults: any[]
): { valid: boolean; violations: string[] } {
  state.graph_trace.push('agent_guardrail');
  const violations: string[] = [];

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
    if (!found) violations.push(`Prix suspect: ${price} MAD`);
  }

  const discountMatch = proposedResponse.match(/(\d+)\s*%/);
  if (discountMatch && parseInt(discountMatch[1]) > DISCOUNT_FLOOR * 100) {
    violations.push(`Remise > ${DISCOUNT_FLOOR * 100}% interdite`);
  }

  const reassortPattern = /(réassort|restock|recevrai|disponible dans)\s+(\d+)/i;
  if (reassortPattern.test(proposedResponse)) {
    violations.push('Délai de réassort promis');
  }

  state.guardrail_violations = violations;
  return { valid: violations.length === 0, violations };
}

// ═══════════════════════════════════════════════════════════════
// AGENT 4 — ESCALADE
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
- Demande explicite d'un humain
- Litige en cours

NE PAS escalader SI :
- Client rit
- Client dit merci
- Client salue
- Client demande livraison dans une ville de la grille

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
        state.conversation_id, state.client_id,
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
// AGENT 5 — RELANCE
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

  const decision = await reason(decisionPrompt, JSON.stringify({ cartSnapshot, customer }), {
    maxTokens: 150,
    json: true,
  });

  const parsed = RelanceSchema.parse(JSON.parse(decision));
  if (!parsed.relancer) return null;

  const message = await execute(
    `Rédige un message de relance WhatsApp en darija, chaleureux et concis.
     Maximum 2 phrases. Rappelle le produit, propose de finaliser.`,
    `Panier : ${JSON.stringify(cartSnapshot)}\nAngle : ${parsed.angle}`,
    { maxTokens: 200 }
  );

  return { message, delai_heures: parsed.delai_heures, angle: parsed.angle };
}

// ═══════════════════════════════════════════════════════════════
// ORCHESTRATEUR PRINCIPAL
// ═══════════════════════════════════════════════════════════════
export async function orchestrateRequest(
  clientId: string,
  rawInput: string,
  conversationId: string | null = null,
  preferredLanguage: string = ''
): Promise<KenzaState> {
  const state = makeInitialState(clientId, rawInput, conversationId, preferredLanguage);

  const customer = await getOrCreateCustomer(clientId);
  state.client_id = customer.client_id;

  const memory = await getClientHistory(state.client_id, 3);
  state.client_memory = memory;

  const conv = await getOrCreateConversation(state.client_id, rawInput);
  state.conversation_id = conv.id;

  const { history } = await getConversationHistory(state.client_id, 10);
  state.conversation_history = history;

  await appendMessage(state.conversation_id!, 'client', rawInput);

  console.log(`💬 Conversation ${state.conversation_id}`);
  console.log(`📜 Historique : ${history.length} messages`);

  // Détection messages non-commerciaux
  const nc = detectNonCommercial(rawInput);
  if (nc.type) {
    state.graph_trace.push(`non_commercial_${nc.type}`);
    const lang = preferredLanguage || 'darija';
    let prompt = '';

    if (nc.type === 'laugh') {
      prompt = `Le client a ri : "${rawInput}". Réponds en ${lang} naturellement. 1 phrase max.`;
    } else if (nc.type === 'thanks') {
      prompt = `Le client a dit merci : "${rawInput}". Réponds en ${lang} gentiment. 1 phrase max.`;
    } else if (nc.type === 'greeting') {
      prompt = `Le client a salué : "${rawInput}". Réponds en ${lang} en saluant et en demandant ce qu'il veut. 1 phrase max.`;
    } else if (nc.type === 'farewell') {
      prompt = `Le client a dit au revoir : "${rawInput}". Réponds en ${lang} chaleureusement. 1 phrase max.`;
    } else if (nc.type === 'ok') {
      prompt = `Le client a confirmé : "${rawInput}". Réponds en ${lang} et demande s'il veut autre chose. 1 phrase max.`;
    }

    state.response = await execute(prompt, rawInput, { maxTokens: 150 });
    await appendMessage(state.conversation_id!, 'agent', state.response);
    return state;
  }

  // COMPRÉHENSION
  state.graph_trace.push('understand_message');
  const understanding = await understandMessage(rawInput, memory, history);

  // ⭐ MODIFICATION B — FORCER la détection par mots-clés
  const detectedFamily = detectFamily(rawInput);
  if (detectedFamily) {
    understanding.product_family = detectedFamily;
    understanding.needs_catalogue = true;
    console.log(`✅ Famille détectée (mots-clés) : ${detectedFamily}`);
  }

  const detectedColor = detectColor(rawInput);
  if (detectedColor && !understanding.color) {
    understanding.color = detectedColor;
    console.log(`✅ Couleur détectée (mots-clés) : ${detectedColor}`);
  }

  // ⭐ MODIFICATION D — FORCER la détection de livraison + ville/quartier
  const isDeliveryRequest = detectDeliveryIntent(rawInput);
  const location = detectLocation(rawInput);

  if (isDeliveryRequest || location.city) {
    understanding.needs_delivery = true;
    if (location.city && !understanding.city) {
      understanding.city = location.city;
    }
    console.log(`✅ Livraison détectée : ${isDeliveryRequest}, Ville : ${location.city || 'N/A'}, Quartier : ${location.quartier || 'N/A'}, Type : ${location.type}`);
  }

  state.language = understanding.language;
  state.preferred_language = state.preferred_language || understanding.language;
  state.intent = understanding.intent;
  state.intent_reasoning = understanding.reasoning;
  state.graph_trace.push(`intent_${understanding.intent.replace(/\s+/g, '_')}`);

  console.log(`🧠 Compréhension : ${understanding.intent}`);
  console.log(`   Raisonnement : ${understanding.reasoning}`);
  console.log(`   Catalogue : ${understanding.needs_catalogue}, Livraison : ${understanding.needs_delivery}, Clarification : ${understanding.needs_clarification}`);
  console.log(`   Famille : ${understanding.product_family || 'N/A'}, Couleur : ${understanding.color || 'N/A'}, Taille : ${understanding.size || 'N/A'}`);

  // CLARIFICATION
  if (understanding.needs_clarification && !understanding.needs_catalogue && !understanding.needs_delivery) {
    state.graph_trace.push('clarification_requested');
    const prompt = `Le client a envoyé : "${rawInput}"
Analyse : intention = "${understanding.intent}", raisonnement = "${understanding.reasoning}"

Réponds en ${state.preferred_language} de manière NATURELLE.
- Si ambigu → demande clarification poliment
- Ne cherche PAS dans le catalogue
- Ne dis PAS "pas de produit"

1-2 phrases max.`;

    state.response = await execute(prompt, rawInput, { maxTokens: 200 });
    await appendMessage(state.conversation_id!, 'agent', state.response);
    return state;
  }

  // ⭐ LIVRAISON (avec détection quartier)
  if (understanding.needs_delivery) {
    state.graph_trace.push('check_delivery');

    let city = understanding.city || detectCity(rawInput);

    // Si on a détecté un quartier mais pas la ville, utiliser la ville du quartier
    if (!city && location.city) {
      city = location.city;
    }

    if (city) {
      const delivery = await catalogueAgent(state, 'delivery', { city });

      if (delivery.result.available) {
        const quartierInfo = location.quartier
          ? `\nQuartier du client : ${location.quartier}`
          : '';

        state.response = await execute(
          `Le client demande la livraison à ${city}.${quartierInfo}
Données OFFICIELLES :
- Frais : ${delivery.result.cost_mad} MAD
- Délai : ${delivery.result.delay_hours}h
- Paiement à la livraison : ${delivery.result.paiement_a_la_livraison ? 'oui' : 'non'}

Réponds en ${state.preferred_language}. Donne le prix et le délai EXACTS. 1-2 phrases.
Confirme l'enregistrement du lieu de livraison.`,
          rawInput,
          { maxTokens: 200 }
        );
      } else {
        state.response = await execute(
          `Le client demande la livraison à ${city}, mais cette ville n'est PAS dans notre grille.
Réponds en ${state.preferred_language} en expliquant poliment et en proposant d'escalader.`,
          rawInput,
          { maxTokens: 200 }
        );
      }
      await appendMessage(state.conversation_id!, 'agent', state.response);
      return state;
    } else {
      state.response = await execute(
        `Le client parle de livraison mais n'a pas précisé la ville.
Demande-lui la ville. Villes : Casablanca, Rabat, Fès, Marrakech, Tanger, Agadir, Meknès, Oujda, Kénitra, Tétouan, Salé, Mohammedia.

Réponds en ${state.preferred_language}. 1-2 phrases max.`,
        rawInput,
        { maxTokens: 150 }
      );
      await appendMessage(state.conversation_id!, 'agent', state.response);
      return state;
    }
  }

  // CATALOGUE
  await escalationAgent(state, rawInput);

  let catalogueContext = '';
  let stockContext = '';

  if (understanding.needs_catalogue) {
    const translatedInput = translateDarija(rawInput);
    const genreFilter = detectGenre(rawInput);
    const requestedColor = understanding.color || detectColor(rawInput);

    console.log(`🔍 Requête originale : ${rawInput}`);
    console.log(`🔍 Requête traduite  : ${translatedInput}`);

    // Cas "tout ce que vous avez"
    if (
      understanding.product_family === 'TOUT' ||
      /ga3 li 3ndkom|tout ce que|tout le magasin|كلشي/i.test(rawInput)
    ) {
      const families = await catalogueAgent(state, 'families', {});
      state.catalogue_results = families.result;

      catalogueContext = families.result
        .map(
          (f: any) =>
            `- ${f.famille} (${f.modele}) — ${f.prix_mad} MAD — tailles dispo : ${(f.tailles_dispo || []).join(', ')}`
        )
        .join('\n');

      state.graph_trace.push('list_all_families');
    }
    // Cas "taille seule"
    else if (
      (isTailleOnly(rawInput) || understanding.size) &&
      state.conversation_history.length > 0
    ) {
      const lastProductMention = state.conversation_history
        .slice()
        .reverse()
        .find(
          (m: any) =>
            m.role === 'agent' &&
            /pantalon|robe|caftan|chaussure|blouson|chemise|veste|sac|ceinture|foulard/i.test(m.content)
        );

      let famille = understanding.product_family;
      if (!famille && lastProductMention) {
        const match = lastProductMention.content.match(
          /pantalon|robe|caftan|chaussure|blouson|chemise|veste|sac|ceinture|foulard/i
        );
        if (match) {
          famille = match[0].charAt(0).toUpperCase() + match[0].slice(1).toLowerCase();
        }
      }

      const requestedSize = understanding.size || rawInput.trim();

      if (famille) {
        const variants = await findVariants(famille, requestedSize);
        state.catalogue_results = variants;

        if (variants.length > 0) {
          state.current_product = variants[0];
          state.current_family = famille;
          state.stock_status = await checkStock(variants[0].ref);
          catalogueContext = `Produit trouvé : ${variants[0].modele} (${famille}, taille ${requestedSize}) — ${variants[0].prix_mad} MAD — stock : ${variants[0].stock}`;
        } else {
          const allVariants = await getFamilyVariants(famille);
          const availableSizes = allVariants
            .filter((v: any) => v.stock > 0)
            .map((v: any) => v.taille);

          catalogueContext = `Taille ${requestedSize} NON disponible pour ${famille}. Tailles dispo : ${availableSizes.join(', ')}.`;
        }
      }
    }
    // Cas recherche normale — ⭐ MODIFICATION C
    else {
      const searchParams: any = {
        query: translatedInput,
        limit: 30,
        genre: genreFilter,
      };

      if (understanding.product_family && understanding.product_family !== 'TOUT') {
        searchParams.famille = understanding.product_family;
        console.log(`🔎 Recherche filtrée par famille : ${understanding.product_family}`);
      }

      const search = await catalogueAgent(state, 'search', searchParams);
      state.catalogue_results = search.result;

      if (search.result.length > 0) {
        const firstProduct = search.result[0];
        state.current_product = firstProduct;
        state.current_family = firstProduct.famille;

        const stock = await catalogueAgent(state, 'stock', { ref: firstProduct.ref });
        state.stock_status = stock.result;
      }
    }

    // VÉRIFIER SI LA FAMILLE DEMANDÉE EXISTE
    const requestedFamily = understanding.product_family;
    let familyNotFound = false;
    let colorNotFound = false;

    if (requestedFamily && requestedFamily !== 'TOUT' && state.catalogue_results.length > 0) {
      const familyProducts = state.catalogue_results.filter(
        (p: any) => p.famille?.toLowerCase().includes(requestedFamily.toLowerCase())
      );

      if (familyProducts.length === 0) {
        familyNotFound = true;
        state.graph_trace.push('family_not_found');
        console.log(`❌ Famille "${requestedFamily}" non trouvée`);
      } else if (requestedColor) {
        const colorProducts = familyProducts.filter(
          (p: any) => p.couleur?.toLowerCase().includes(requestedColor.toLowerCase())
        );
        if (colorProducts.length === 0) {
          colorNotFound = true;
          state.graph_trace.push('color_not_found');
          console.log(`❌ Couleur "${requestedColor}" non trouvée pour "${requestedFamily}"`);
        }
      }
    }

    // CAS 1 : Famille introuvable → proposer alternative SANS demander la taille
    if (familyNotFound) {
      const alternativeFamilies = await getAllFamilies();
      const alternatives = alternativeFamilies.slice(0, 8);

      const altContext = alternatives
        .map(
          (f: any) =>
            `- ${f.famille} (${f.modele}) — ${f.prix_mad} MAD`
        )
        .join('\n');

      state.response = await execute(
        `Le client demande un produit de la famille "${requestedFamily}", mais nous n'avons AUCUN produit de cette famille.

RÈGLES STRICTES :
- NE JAMAIS proposer un produit d'une famille DIFFÉRENTE
- NE JAMAIS demander la taille
- Dire honnêtement que "${requestedFamily}" n'est pas disponible
- Proposer UNIQUEMENT de regarder d'autres familles
- Ne pas insister

FAMILLES DISPONIBLES :
${altContext}

Réponds en ${state.preferred_language}. 1-2 phrases max.
Ne demande PAS la taille.`,
        rawInput,
        { maxTokens: 200 }
      );
      await appendMessage(state.conversation_id!, 'agent', state.response);
      return state;
    }

    // CAS 2 : Couleur introuvable → proposer autres couleurs
    if (colorNotFound) {
      const familyProducts = state.catalogue_results.filter(
        (p: any) => p.famille?.toLowerCase().includes(requestedFamily!.toLowerCase())
      );

      state.response = await execute(
        `Le client demande "${requestedFamily}" en couleur "${requestedColor}", mais cette couleur N'EST PAS disponible.

Ce qui EST disponible dans "${requestedFamily}" :
${familyProducts
  .map(
    (p: any) =>
      `- ${p.modele} (${p.couleur}, taille ${p.taille}) — ${p.prix_mad} MAD`
  )
  .join('\n')}

RÈGLES STRICTES :
- Dire honnêtement que "${requestedColor}" n'est pas disponible
- Proposer UNIQUEMENT les autres couleurs DISPONIBLES de la MÊME famille
- NE JAMAIS proposer une autre famille
- NE PAS demander la taille

Réponds en ${state.preferred_language}. 1-2 phrases max.`,
        rawInput,
        { maxTokens: 200 }
      );
      await appendMessage(state.conversation_id!, 'agent', state.response);
      return state;
    }

    // Construire le catalogue groupé
    if (state.catalogue_results.length > 0) {
      const grouped: Record<string, any[]> = {};
      for (const p of state.catalogue_results) {
        if (!grouped[p.famille]) grouped[p.famille] = [];
        grouped[p.famille].push(p);
      }

      const familyContexts: string[] = [];
      for (const [famille, products] of Object.entries(grouped)) {
        const availableProducts = products.filter((p: any) => p.stock > 0);
        if (availableProducts.length === 0) continue;

        const productName = availableProducts[0].modele;
        const price = availableProducts[0].prix_mad;
        const sizes = availableProducts.map((p: any) => p.taille).join(', ');
        const colors = [...new Set(availableProducts.map((p: any) => p.couleur))].join(', ');

        familyContexts.push(
          `- ${famille} — ${productName} — ${price} MAD — tailles : ${sizes} — couleurs : ${colors}`
        );
      }

      catalogueContext = familyContexts.join('\n');
    }

    if (state.stock_status && state.stock_status.ref) {
      stockContext = `${state.stock_status.available ? `disponible (${state.stock_status.quantity} unités)` : 'RUPTURE DE STOCK'}`;
    }

    // CAS 3 : Demander la taille
    if (
      state.current_product &&
      !hasSizeSpecified(rawInput) &&
      !SIZE_LESS_FAMILIES.includes(state.current_family) &&
      !isTailleOnly(rawInput) &&
      !understanding.size &&
      !rawInput.match(/commande|commander|ncommandi|bghit nchri/i)
    ) {
      state.graph_trace.push('ask_size');
      const prompt = `Le client demande : "${rawInput}"
Produit trouvé : ${state.current_product.modele}
Couleur : ${state.current_product.couleur}
Tailles disponibles : ${state.current_product.taille}
Prix : ${state.current_product.prix_mad} MAD

Réponds en ${state.preferred_language} en :
1. Confirmant que le produit est disponible
2. Donnant le prix
3. DEMANDANT la taille

Ne JAMAIS inventer une taille. 1-2 phrases max.`;

      state.response = await execute(prompt, rawInput, { maxTokens: 150 });
      await appendMessage(state.conversation_id!, 'agent', state.response);
      return state;
    }
  }

  // Négociation
  if (
    understanding.intent.includes('remise') ||
    understanding.intent.includes('negociation') ||
    /remise|tanqis|réduction/i.test(rawInput)
  ) {
    const discountMatch = rawInput.match(/(\d+)\s*%/);
    const requested = discountMatch ? parseInt(discountMatch[1]) / 100 : 0;
    const elig = verifyDiscountEligibility(requested);
    if (elig.needs_human_review) {
      state.needs_human_review = true;
      state.escalation_reasons.push(...elig.rejection_reasons);
    }
  }

  // GÉNÉRER LA RÉPONSE
  state.graph_trace.push('generate_response');

  await conversationAgent(state, rawInput, catalogueContext, stockContext);

  await appendMessage(state.conversation_id!, 'agent', state.response);

  // Garde-fou final
  const guardrail = guardrailAgent(state, state.response, state.tool_calls);
  if (!guardrail.valid) {
    state.needs_human_review = true;
    state.escalation_reasons.push(...guardrail.violations);
  }

  return state;
}