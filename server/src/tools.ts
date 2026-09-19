import dotenv from 'dotenv';
dotenv.config();

import { db } from './db';
import { embed } from './llm';

// ═══════════════════════════════════════════════════════════════
// CONSTANTES MÉTIER
// ═══════════════════════════════════════════════════════════════
export const DISCOUNT_FLOOR = 0.10;

export const DISCOUNT_CODES: Record<string, number> = {
  LOYAL10: 0.10,
  WELCOME5: 0.05,
};

// ═══════════════════════════════════════════════════════════════
// OUTIL 1 — search_product (RECHERCHE HYBRIDE : mots-clés + embedding)
// ⭐ Utilise le paramètre `famille` passé par agents.ts
// ═══════════════════════════════════════════════════════════════
export async function searchProduct(
  query: string,
  limit = 30,
  genre?: string,
  famille?: string
) {
  const queryLower = query.toLowerCase().trim();

  // ⭐ Mots-clés structurés
  const FAMILLES = [
    'pantalon',
    'robe',
    'caftan',
    'chaussures',
    'blouson',
    'chemise',
    'veste',
    'sac',
    'ceinture',
    'foulard',
    'costume',
    'montre',
    'sandales',
    'baskets',
    'bottes',
    'chemisier',
    'pull',
    'manteau',
  ];

  const COULEURS = [
    'beige',
    'noir',
    'noire',
    'blanc',
    'blanche',
    'bleu',
    'bleue',
    'rouge',
    'vert',
    'verte',
    'jaune',
    'rose',
    'marron',
    'gris',
    'grise',
    'doré',
    'argenté',
    'terracotta',
    'camel',
    'ivoire',
    'olive',
    'bordeaux',
    'turquoise',
    'bleu nuit',
    'gris perle',
    'blanc cassé',
    'vert olive',
  ];

  const TAILLES = [
    '38',
    '39',
    '40',
    '41',
    '42',
    '43',
    '44',
    '45',
    '46',
    'S',
    'M',
    'L',
    'XL',
    'XXL',
    'unique',
  ];

  const famillesTrouvees = FAMILLES.filter((f) => queryLower.includes(f));
  const couleursTrouvees = COULEURS.filter((c) => queryLower.includes(c));
  const taillesTrouvees = TAILLES.filter((t) => {
    const regex = new RegExp(`\\b${t.toLowerCase()}\\b`, 'i');
    return regex.test(queryLower);
  });

  // ⭐ CORRECTION : utiliser le paramètre famille si aucune famille dans la requête
  const familleEffective = famillesTrouvees.length > 0
    ? famillesTrouvees
    : (famille ? [famille] : []);

  console.log(
    `🔎 Extraction : familles=[${famillesTrouvees}], couleurs=[${couleursTrouvees}], tailles=[${taillesTrouvees}]`
  );
  if (famille && famillesTrouvees.length === 0) {
    console.log(`🎯 Famille fournie en paramètre : ${famille}`);
  }

  // ⭐ ÉTAPE 1 : Recherche SQL directe si famille détectée OU passée
  if (familleEffective.length > 0) {
    let sql = `SELECT ref, modele, famille, genre, couleur, taille, matiere, saison,
                      prix_mad, stock, delai_reassort_jours
               FROM products
               WHERE stock > 0`;
    const params: any[] = [];

    const familyConditions = familleEffective.map((f) => {
      params.push(`%${f.toLowerCase()}%`);
      return `LOWER(famille) LIKE $${params.length}`;
    });
    sql += ` AND (${familyConditions.join(' OR ')})`;

    if (couleursTrouvees.length > 0) {
      const colorConditions = couleursTrouvees.map((c) => {
        params.push(`%${c}%`);
        return `LOWER(couleur) LIKE $${params.length}`;
      });
      sql += ` AND (${colorConditions.join(' OR ')})`;
    }

    if (taillesTrouvees.length > 0) {
      const sizeConditions = taillesTrouvees.map((t) => {
        params.push(t);
        return `taille = $${params.length}`;
      });
      sql += ` AND (${sizeConditions.join(' OR ')})`;
    }

    if (genre) {
      params.push(genre);
      sql += ` AND (genre = $${params.length} OR genre = 'mixte')`;
    }

    sql += ` ORDER BY taille, couleur LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await db.query(sql, params);
    console.log(`✅ Recherche SQL directe : ${result.rows.length} résultats`);

    if (result.rows.length > 0) {
      return result.rows;
    }
  }

  // ⭐ ÉTAPE 2 : Fallback embedding
  console.log(`🔄 Fallback embedding pour : "${query}"`);
  const queryEmbedding = await embed(query);

  let sql = `SELECT ref, modele, famille, genre, couleur, taille, matiere, saison,
                    prix_mad, stock, delai_reassort_jours,
                    1 - (embedding <=> $1) AS similarity
             FROM products
             WHERE stock > 0`;
  const params: any[] = [JSON.stringify(queryEmbedding)];

  if (genre) {
    sql += ` AND (genre = $${params.length + 1} OR genre = 'mixte')`;
    params.push(genre);
  }

  if (famille) {
    sql += ` AND LOWER(famille) LIKE $${params.length + 1}`;
    params.push(`%${famille.toLowerCase()}%`);
  }

  sql += ` ORDER BY embedding <=> $1 LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await db.query(sql, params);

  // Filtre pertinence
  const filtered = result.rows.filter((r: any) => (r.similarity || 0) > 0.3);
  return filtered.length > 0 ? filtered : result.rows.slice(0, 5);
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 1bis — getFamilyVariants
// ═══════════════════════════════════════════════════════════════
export async function getFamilyVariants(famille: string) {
  const result = await db.query(
    `SELECT ref, modele, famille, genre, couleur, taille, matiere, saison,
            prix_mad, stock
     FROM products
     WHERE famille = $1
     ORDER BY taille, couleur`,
    [famille]
  );
  return result.rows;
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 1ter — findVariants
// ═══════════════════════════════════════════════════════════════
export async function findVariants(famille: string, taille?: string) {
  let sql = `SELECT ref, modele, famille, genre, couleur, taille, matiere, saison,
                    prix_mad, stock
             FROM products
             WHERE famille = $1 AND stock > 0`;
  const params: any[] = [famille];

  if (taille) {
    sql += ` AND taille = $2`;
    params.push(taille);
  }

  sql += ` ORDER BY taille`;

  const result = await db.query(sql, params);
  return result.rows;
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 1quater — getAllFamilies
// ═══════════════════════════════════════════════════════════════
export async function getAllFamilies() {
  const result = await db.query(
    `SELECT DISTINCT famille, modele, prix_mad,
            array_agg(DISTINCT taille) FILTER (WHERE stock > 0) AS tailles_dispo,
            SUM(stock) AS stock_total
     FROM products
     GROUP BY famille, modele, prix_mad
     HAVING SUM(stock) > 0
     ORDER BY famille`
  );
  return result.rows;
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 2 — check_stock
// ═══════════════════════════════════════════════════════════════
export async function checkStock(ref: string) {
  const result = await db.query(
    `SELECT ref, modele, famille, genre, couleur, taille, matiere, saison,
            prix_mad, stock, delai_reassort_jours
     FROM products WHERE ref = $1`,
    [ref]
  );

  if (result.rows.length === 0) {
    return { ref, available: false, quantity: 0, substitutes: [] };
  }

  const p = result.rows[0];
  const available = p.stock > 0;

  let substitutes: any[] = [];
  if (!available) {
    const subs = await db.query(
      `SELECT ref, modele, couleur, taille, prix_mad, stock
       FROM products
       WHERE famille = $1 AND stock > 0 AND ref != $2
       LIMIT 3`,
      [p.famille, ref]
    );
    substitutes = subs.rows;
  }

  return {
    ref,
    available,
    quantity: p.stock,
    modele: p.modele,
    famille: p.famille,
    couleur: p.couleur,
    taille: p.taille,
    matiere: p.matiere,
    saison: p.saison,
    prix_mad: parseFloat(p.prix_mad),
    delai_reassort_jours: p.delai_reassort_jours,
    substitutes,
  };
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 3 — calculate_delivery
// ═══════════════════════════════════════════════════════════════
export async function calculateDelivery(city: string) {
  const result = await db.query(
    `SELECT ville, frais_mad, delai_heures, paiement_a_la_livraison, retrait_boutique
     FROM delivery_grid WHERE ville = $1`,
    [city]
  );

  if (result.rows.length === 0) {
    return {
      city,
      available: false,
      cost_mad: null,
      delay_hours: null,
      needs_escalation: true,
      reason: `Ville "${city}" absente de la grille de livraison`,
    };
  }

  const row = result.rows[0];
  return {
    city: row.ville,
    available: true,
    cost_mad: row.frais_mad,
    delay_hours: row.delai_heures,
    paiement_a_la_livraison: row.paiement_a_la_livraison,
    retrait_boutique: row.retrait_boutique,
    needs_escalation: false,
  };
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 4 — calculate_cart_total
// ═══════════════════════════════════════════════════════════════
export async function calculateCartTotal(
  items: { ref: string; quantity: number }[],
  city: string,
  discountCode: string = ''
) {
  let subtotal = 0;
  const pricedItems: any[] = [];

  for (const item of items) {
    const p = await db.query(
      `SELECT ref, modele, prix_mad FROM products WHERE ref = $1`,
      [item.ref]
    );
    if (p.rows.length > 0) {
      const unitPrice = parseFloat(p.rows[0].prix_mad);
      subtotal += unitPrice * item.quantity;
      pricedItems.push({
        ref: item.ref,
        modele: p.rows[0].modele,
        quantity: item.quantity,
        unit_price: unitPrice,
      });
    }
  }

  const delivery = await calculateDelivery(city);

  let discountAmount = 0;
  let discountCapped = false;
  let discountNote = 'Aucune remise appliquée';

  if (discountCode && DISCOUNT_CODES[discountCode] !== undefined) {
    const nominal = DISCOUNT_CODES[discountCode];
    const effective = Math.min(nominal, DISCOUNT_FLOOR);
    discountAmount = Math.round(subtotal * effective * 100) / 100;
    discountCapped = nominal > DISCOUNT_FLOOR;

    if (discountCapped) {
      discountNote = `Code '${discountCode}' plafonné à 10% (plancher métier). Remise effective : ${discountAmount} MAD`;
    } else {
      discountNote = `Code '${discountCode}' : ${nominal * 100}%. Remise : ${discountAmount} MAD`;
    }
  }

  const deliveryCost = delivery.cost_mad || 0;
  const total = Math.max(
    0,
    Math.round((subtotal + deliveryCost - discountAmount) * 100) / 100
  );

  return {
    items: pricedItems,
    subtotal: Math.round(subtotal * 100) / 100,
    delivery_city: city,
    delivery_cost: deliveryCost,
    delivery_delay_hours: delivery.delay_hours,
    delivery_available: delivery.available,
    discount_code: discountCode,
    discount_amount: discountAmount,
    discount_capped: discountCapped,
    discount_note: discountNote,
    total,
    needs_human_review: discountCapped || !delivery.available,
  };
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 5 — create_order
// ═══════════════════════════════════════════════════════════════
export async function createOrder(
  clientId: string,
  items: { ref: string; modele: string; quantity: number; unit_price: number }[],
  deliveryCost: number,
  discount: number = 0,
  villeLivraison: string = '',
  paiement: string = 'à la livraison'
) {
  const totalArticles = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  const total = Math.max(0, totalArticles + deliveryCost - discount);

  const countResult = await db.query(`SELECT COUNT(*) FROM orders`);
  const nextId = `CMD-${String(parseInt(countResult.rows[0].count) + 1).padStart(5, '0')}`;

  const result = await db.query(
    `INSERT INTO orders (commande_id, client_id, date, canal, statut,
                         total_articles_mad, frais_livraison_mad, total_mad,
                         ville_livraison, paiement, items)
     VALUES ($1,$2,CURRENT_DATE,'whatsapp','en préparation',$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      nextId,
      clientId,
      totalArticles,
      deliveryCost,
      total,
      villeLivraison,
      paiement,
      JSON.stringify(items),
    ]
  );

  return result.rows[0];
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 6 — verify_discount_eligibility
// ═══════════════════════════════════════════════════════════════
export function verifyDiscountEligibility(discountRequested: number) {
  const eligible = discountRequested <= DISCOUNT_FLOOR;
  const needsReview = !eligible;

  const reasons: string[] = [];
  if (!eligible) {
    reasons.push(
      `Remise demandée (${(discountRequested * 100).toFixed(0)}%) > plancher (${DISCOUNT_FLOOR * 100}%)`
    );
  }

  return {
    eligible,
    discount_requested: discountRequested,
    discount_max: DISCOUNT_FLOOR,
    needs_human_review: needsReview,
    rejection_reasons: reasons,
  };
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 7 — create_escalation
// ═══════════════════════════════════════════════════════════════
export async function createEscalation(
  conversationId: string | null,
  clientId: string | null,
  reason: string,
  context: any
) {
  const result = await db.query(
    `INSERT INTO escalations (conversation_id, client_id, reason, context, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING *`,
    [conversationId, clientId, reason, JSON.stringify(context)]
  );
  return result.rows[0];
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 8 — get_or_create_customer
// ═══════════════════════════════════════════════════════════════
export async function getOrCreateCustomer(phone: string) {
  const existing = await db.query(
    `SELECT * FROM customers WHERE telephone = $1`,
    [phone]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const countResult = await db.query(`SELECT COUNT(*) FROM customers`);
  const nextId = `CLI-${String(parseInt(countResult.rows[0].count) + 1).padStart(4, '0')}`;

  const created = await db.query(
    `INSERT INTO customers (client_id, nom, telephone, ville, langue_preferee, segment)
     VALUES ($1, $2, $3, $4, 'darija', 'nouveau')
     RETURNING *`,
    [nextId, `Client ${phone.slice(-4)}`, phone, 'Casablanca']
  );
  return created.rows[0];
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 9 — get_client_history
// ═══════════════════════════════════════════════════════════════
export async function getClientHistory(clientId: string, limit = 5) {
  const client = await db.query(
    `SELECT * FROM customers WHERE client_id = $1`,
    [clientId]
  );

  const orders = await db.query(
    `SELECT commande_id, date, statut, total_mad, items
     FROM orders
     WHERE client_id = $1
     ORDER BY date DESC
     LIMIT $2`,
    [clientId, limit]
  );

  return {
    client: client.rows[0] || null,
    recent_orders: orders.rows,
  };
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 10 — search_policies (RAG)
// ═══════════════════════════════════════════════════════════════
export async function searchPolicies(query: string, limit = 3) {
  const queryEmbedding = await embed(query);
  const result = await db.query(
    `SELECT category, content,
            1 - (embedding <=> $1) AS similarity
     FROM policies
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [JSON.stringify(queryEmbedding), limit]
  );
  return result.rows;
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 11 — getOrCreateConversation
// ═══════════════════════════════════════════════════════════════
export async function getOrCreateConversation(
  clientId: string,
  firstMessage: string
) {
  const existing = await db.query(
    `SELECT * FROM conversations 
     WHERE client_id = $1 AND status = 'active'
     AND started_at > NOW() - INTERVAL '24 hours'
     ORDER BY started_at DESC 
     LIMIT 1`,
    [clientId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const created = await db.query(
    `INSERT INTO conversations (client_id, channel, status, messages)
     VALUES ($1, 'web_simulator', 'active', ARRAY[$2::jsonb])
     RETURNING *`,
    [clientId, JSON.stringify({ role: 'client', content: firstMessage })]
  );
  return created.rows[0];
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 12 — appendMessage
// ═══════════════════════════════════════════════════════════════
export async function appendMessage(
  conversationId: string,
  role: 'client' | 'agent',
  content: string
) {
  await db.query(
    `UPDATE conversations 
     SET messages = messages || ARRAY[$1::jsonb]
     WHERE id = $2`,
    [
      JSON.stringify({ role, content, timestamp: new Date().toISOString() }),
      conversationId,
    ]
  );
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 13 — getConversationHistory
// ═══════════════════════════════════════════════════════════════
export async function getConversationHistory(clientId: string, limit = 10) {
  const result = await db.query(
    `SELECT id, messages, started_at 
     FROM conversations 
     WHERE client_id = $1 AND status = 'active'
     AND started_at > NOW() - INTERVAL '24 hours'
     ORDER BY started_at DESC 
     LIMIT 1`,
    [clientId]
  );

  if (result.rows.length === 0) {
    return { conversation_id: null, history: [] };
  }

  const conv = result.rows[0];
  const messages = (conv.messages || []).slice(-limit);
  const history = messages.map((m: any) => ({
    role: m.role,
    content: m.content,
  }));

  return { conversation_id: conv.id, history };
}