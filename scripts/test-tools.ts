import dotenv from 'dotenv';
dotenv.config();

import {
  searchProduct,
  checkStock,
  calculateDelivery,
  calculateCartTotal,
  verifyDiscountEligibility,
  createEscalation,
  getOrCreateCustomer,
} from '../server/src/tools';
import { db } from '../server/src/db';

async function main() {
  console.log('🧪 Test des outils déterministes\n');

  let passed = 0;
  const total = 10;

  // T1 — Recherche produit
  const r1 = await searchProduct('t-shirt');
  if (r1.length > 0) {
    console.log(`✅ T1 — searchProduct("t-shirt") → ${r1.length} résultats`);
    passed++;
  } else {
    console.log('❌ T1 — searchProduct');
  }

  // T2 — Recherche en darija
  const r2 = await searchProduct('sabbat byed');
  if (r2.length > 0) {
    console.log(`✅ T2 — searchProduct("sabbat byed") → ${r2.length} résultats`);
    passed++;
  } else {
    console.log('❌ T2 — searchProduct darija');
  }

  // T3 — Stock disponible
  const r3 = await checkStock('TSHIRT-001');
  if (r3.available === true) {
    console.log(`✅ T3 — checkStock("TSHIRT-001") → disponible`);
    passed++;
  } else {
    console.log('❌ T3 — checkStock');
  }

  // T4 — Rupture de stock → substituts
  const r4 = await checkStock('TSHIRT-003');
  if (r4.available === false && r4.substitutes.length > 0) {
    console.log(
      `✅ T4 — checkStock("TSHIRT-003") → rupture + ${r4.substitutes.length} substituts`
    );
    passed++;
  } else {
    console.log('❌ T4 — checkStock rupture');
  }

  // T5 — Livraison Casablanca
  const r5 = calculateDelivery('Casablanca');
  if (r5.cost_mad === 25) {
    console.log(`✅ T5 — calculateDelivery("Casablanca") → 25 MAD`);
    passed++;
  } else {
    console.log('❌ T5 — calculateDelivery');
  }

  // T6 — Total panier simple
  const r6 = await calculateCartTotal(
    [{ sku: 'TSHIRT-001', quantity: 2 }],
    'Casablanca'
  );
  if (r6.total === 325) {
    console.log(`✅ T6 — calculateCartTotal → ${r6.total} MAD`);
    passed++;
  } else {
    console.log(`❌ T6 — calculateCartTotal → ${r6.total} (attendu: 325)`);
  }

  // T7 — Remise 20% plafonnée à 15%
  const r7 = await calculateCartTotal(
    [{ sku: 'TSHIRT-001', quantity: 2 }],
    'Casablanca',
    'SUMMER20'
  );
  if (r7.discount_capped === true && r7.discount_amount === 45) {
    console.log(`✅ T7 — Remise plafonnée à 15% → ${r7.discount_amount} MAD`);
    passed++;
  } else {
    console.log(`❌ T7 — Plafond remise → ${r7.discount_amount} MAD`);
  }

  // T8 — Remise 30% refusée (escalade)
  const r8 = verifyDiscountEligibility(0.3);
  if (r8.eligible === false && r8.needs_human_review === true) {
    console.log(`✅ T8 — Remise 30% → escalade humaine`);
    passed++;
  } else {
    console.log('❌ T8 — verifyDiscountEligibility');
  }

  // T9 — Création client
  const r9 = await getOrCreateCustomer('+212600000001');
  if (r9 && r9.id) {
    console.log(`✅ T9 — getOrCreateCustomer → ${r9.id.slice(0, 8)}...`);
    passed++;
  } else {
    console.log('❌ T9 — getOrCreateCustomer');
  }

  // T10 — Création escalade
  const r10 = await createEscalation(null, 'Test escalade', { test: true });
  if (r10 && r10.id) {
    console.log(`✅ T10 — createEscalation → ${r10.id.slice(0, 8)}...`);
    passed++;
  } else {
    console.log('❌ T10 — createEscalation');
  }

  console.log(`\n📊 TOOLS_TESTS = ${passed}/${total} PASS`);

  await db.end();
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error('❌ Erreur:', e);
  process.exit(1);
});