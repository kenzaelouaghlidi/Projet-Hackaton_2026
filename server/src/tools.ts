import dotenv from 'dotenv';
dotenv.config();

import { db } from './db';
import { embed } from './llm';

// ═══════════════════════════════════════════════════════════════
// CONSTANTES MÉTIER — D'après politique-commerciale.md
// ═══════════════════════════════════════════════════════════════
export const DISCOUNT_FLOOR = 0.10;  // 10% max sans validation humaine

export const DISCOUNT_CODES: Record<string, number> = {
  LOYAL10: 0.10,
  WELCOME5: 0.05,
};

// ═══════════════════════════════════════════════════════════════
// OUTIL 1 — search_product (recherche sémantique via pgvector)
// ═══════════════════════════════════════════════════════════════
export async function searchProduct(query: string, limit = 5) {
  const queryEmbedding = await embed(query);
  const result = await db.query(
    `SELECT ref, modele, famille, genre, couleur, taille, matiere, saison,
            prix_mad, stock, delai_reassort_jours,
            1 - (embedding <=> $1) AS similarity
     FROM products
     WHERE stock > 0
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [JSON.stringify(queryEmbedding), limit]
  );
  return result.rows;
}

// ═══════════════════════════════════════════════════════════════
// OUTIL 2 — check_stock (vérifie stock + substituts si rupture)
// RÈGLE : ne JAMAIS promettre un délai de réapprovisionnement
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
// OUTIL 3 — calculate_delivery (grille depuis la base)
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
// RÈGLE : remise plafonnée à 10%, plancher = max(total, 0)
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
// OUTIL 5 — create_order (crée une commande en base)
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

  // Générer un ID unique
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
// RÈGLE : remise > 10% → escalade humaine obligatoire
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
// OUTIL 9 — get_client_history (mémoire par client)
// EX-04 : mémoire client
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