import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { embed, embedBatch } from '../server/src/llm';

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ═══════════════════════════════════════════════════════════════
// Parser CSV simple
// ═══════════════════════════════════════════════════════════════
function parseCSV(content: string): any[] {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());

    const row: any = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }
  return rows;
}

function readCSV(filename: string): any[] {
  const content = fs.readFileSync(
    path.join(__dirname, '../data', filename),
    'utf-8'
  );
  return parseCSV(content);
}

// ═══════════════════════════════════════════════════════════════
// SEED
// ═══════════════════════════════════════════════════════════════
async function seed() {
  console.log('🌱 Seed avec les VRAIES données du hackathon...\n');

  // ═══ 1. Produits ═══
  console.log('📦 Chargement catalogue.csv...');
  const catalogue = readCSV('catalogue.csv');
  console.log(`   ${catalogue.length} produits trouvés`);

  console.log('   Calcul des embeddings (batch)...');
  const productTexts = catalogue.map(
    (p) =>
      `${p.modele} ${p.famille} ${p.couleur} ${p.matiere} ${p.saison} ${p.taille}`
  );
  const productEmbeddings = await embedBatch(productTexts);

  for (let i = 0; i < catalogue.length; i++) {
    const p = catalogue[i];
    await db.query(
      `INSERT INTO products (ref, modele, famille, genre, couleur, taille, matiere, saison,
                             prix_mad, stock, delai_reassort_jours, code_barre, poids_g, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (ref) DO UPDATE SET
         modele = EXCLUDED.modele, famille = EXCLUDED.famille, genre = EXCLUDED.genre,
         couleur = EXCLUDED.couleur, taille = EXCLUDED.taille, matiere = EXCLUDED.matiere,
         saison = EXCLUDED.saison, prix_mad = EXCLUDED.prix_mad, stock = EXCLUDED.stock,
         delai_reassort_jours = EXCLUDED.delai_reassort_jours,
         code_barre = EXCLUDED.code_barre, poids_g = EXCLUDED.poids_g,
         embedding = EXCLUDED.embedding`,
      [
        p.ref,
        p.modele,
        p.famille,
        p.genre,
        p.couleur,
        p.taille,
        p.matiere,
        p.saison,
        parseFloat(p.prix_mad) || 0,
        parseInt(p.stock) || 0,
        p.delai_reassort_jours ? parseInt(p.delai_reassort_jours) : null,
        p.code_barre || null,
        p.poids_g ? parseInt(p.poids_g) : null,
        JSON.stringify(productEmbeddings[i]),
      ]
    );
  }
  console.log(`   ✅ ${catalogue.length} produits insérés\n`);

  // ═══ 2. Clients ═══
  console.log('👤 Chargement clients.csv...');
  const clients = readCSV('clients.csv');
  console.log(`   ${clients.length} clients trouvés`);

  for (const c of clients) {
    await db.query(
      `INSERT INTO customers (client_id, nom, telephone, ville, langue_preferee,
                              premier_achat, nb_commandes, segment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (client_id) DO UPDATE SET
         nom = EXCLUDED.nom, telephone = EXCLUDED.telephone, ville = EXCLUDED.ville,
         langue_preferee = EXCLUDED.langue_preferee, premier_achat = EXCLUDED.premier_achat,
         nb_commandes = EXCLUDED.nb_commandes, segment = EXCLUDED.segment`,
      [
        c.client_id,
        c.nom,
        c.telephone,
        c.ville,
        c.langue_preferee,
        c.premier_achat || null,
        parseInt(c.nb_commandes) || 0,
        c.segment,
      ]
    );
  }
  console.log(`   ✅ ${clients.length} clients insérés\n`);

  // ═══ 3. Grille de livraison ═══
  console.log('🚚 Chargement livraison.csv...');
  const livraison = readCSV('livraison.csv');
  for (const l of livraison) {
    await db.query(
      `INSERT INTO delivery_grid (ville, frais_mad, delai_heures, paiement_a_la_livraison, retrait_boutique)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (ville) DO UPDATE SET
         frais_mad = EXCLUDED.frais_mad, delai_heures = EXCLUDED.delai_heures,
         paiement_a_la_livraison = EXCLUDED.paiement_a_la_livraison,
         retrait_boutique = EXCLUDED.retrait_boutique`,
      [
        l.ville,
        parseInt(l.frais_mad),
        parseInt(l.delai_heures),
        l.paiement_a_la_livraison === 'oui',
        l.retrait_boutique === 'oui',
      ]
    );
  }
  console.log(`   ✅ ${livraison.length} villes insérées\n`);

  // ═══ 4. Promotions ═══
  console.log('🎁 Chargement promotions.csv...');
  const promos = readCSV('promotions.csv');
  for (const p of promos) {
    await db.query(
      `INSERT INTO promotions (ref, modele, prix_normal_mad, prix_promo_mad, debut, fin, condition)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (ref, debut) DO UPDATE SET
         prix_normal_mad = EXCLUDED.prix_normal_mad,
         prix_promo_mad = EXCLUDED.prix_promo_mad,
         fin = EXCLUDED.fin, condition = EXCLUDED.condition`,
      [
        p.ref,
        p.modele,
        parseFloat(p.prix_normal_mad),
        parseFloat(p.prix_promo_mad),
        p.debut,
        p.fin,
        p.condition,
      ]
    );
  }
  console.log(`   ✅ ${promos.length} promotions insérées\n`);

  // ═══ 5. Commandes ═══
  console.log('📑 Chargement commandes.csv + commandes-lignes.csv...');
  const commandes = readCSV('commandes.csv');
  const lignes = readCSV('commandes-lignes.csv');

  const lignesByCommande: Record<string, any[]> = {};
  for (const l of lignes) {
    if (!lignesByCommande[l.commande_id]) lignesByCommande[l.commande_id] = [];
    lignesByCommande[l.commande_id].push({
      ref: l.ref,
      modele: l.modele,
      taille: l.taille,
      quantite: parseInt(l.quantite) || 1,
      prix_unitaire_mad: parseFloat(l.prix_unitaire_mad) || 0,
    });
  }

  for (const c of commandes) {
    await db.query(
      `INSERT INTO orders (commande_id, client_id, date, canal, statut,
                           total_articles_mad, frais_livraison_mad, total_mad,
                           ville_livraison, paiement, items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (commande_id) DO UPDATE SET
         statut = EXCLUDED.statut, items = EXCLUDED.items`,
      [
        c.commande_id,
        c.client_id,
        c.date || null,
        c.canal,
        c.statut,
        parseFloat(c.total_articles_mad) || 0,
        parseFloat(c.frais_livraison_mad) || 0,
        parseFloat(c.total_mad) || 0,
        c.ville_livraison,
        c.paiement,
        JSON.stringify(lignesByCommande[c.commande_id] || []),
      ]
    );
  }
  console.log(`   ✅ ${commandes.length} commandes insérées\n`);

  // ═══ 6. Conversations historiques ═══
  console.log('💬 Chargement conversations.jsonl...');
  const convPath = path.join(__dirname, '../data/conversations.jsonl');
  if (fs.existsSync(convPath)) {
    const lines = fs.readFileSync(convPath, 'utf-8').trim().split('\n');
    let inserted = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const conv = JSON.parse(line);
        await db.query(
          `INSERT INTO historical_conversations (id, intention, langue, difficulte,
                                                  client_id, telephone, ville, canal, tours)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET tours = EXCLUDED.tours`,
          [
            conv.id,
            conv.intention,
            conv.langue,
            conv.difficulte,
            conv.client_id,
            conv.telephone,
            conv.ville,
            conv.canal,
            JSON.stringify(conv.tours),
          ]
        );
        inserted++;
      } catch (e: any) {
        console.log(`   ⚠️ Ligne ignorée: ${e.message?.slice(0, 80)}`);
      }
    }
    console.log(`   ✅ ${inserted} conversations insérées\n`);
  }

  // ═══ 7. Politiques (RAG) ═══
  console.log('📄 Chargement politique-commerciale.md + faq-boutique.md...');
  const policyFiles = ['politique-commerciale.md', 'faq-boutique.md'];
  for (const file of policyFiles) {
    const content = fs.readFileSync(
      path.join(__dirname, '../data', file),
      'utf-8'
    );
    const chunks = content.split('\n\n').filter((c) => c.trim().length > 20);

    for (const chunk of chunks) {
      const embedding = await embed(chunk);
      await db.query(
        `INSERT INTO policies (category, content, embedding) VALUES ($1,$2,$3)`,
        [file, chunk, JSON.stringify(embedding)]
      );
    }
    console.log(`   ✅ ${file} : ${chunks.length} chunks indexés`);
  }

  console.log('\n🎉 Seed terminé avec succès !');
  await db.end();
}

seed().catch((e) => {
  console.error('❌ Erreur seed:', e);
  process.exit(1);
});