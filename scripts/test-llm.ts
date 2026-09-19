import dotenv from 'dotenv';
dotenv.config();

import { reason, execute, embed, classifyIntent, detectLanguage, callCounts } from '../server/src/llm';

async function main() {
  console.log('🧪 Test de connexion aux 3 endpoints...\n');

  try {
    console.log('1️⃣ GPT-5.5 (raisonnement)...');
    const r1 = await reason('Tu es un assistant de test.', 'Réponds juste "OK".');
    console.log(`   ✅ ${r1.trim()}\n`);

    console.log('2️⃣ GPT-4.1 (volume)...');
    const r2 = await execute('Tu es un assistant.', 'Réponds "OK".');
    console.log(`   ✅ ${r2.trim()}\n`);

    console.log('3️⃣ Classification intention (darija)...');
    const intent = await classifyIntent("chhal taman had l'article ?");
    console.log(`   ✅ Intent: ${intent.trim()}\n`);

    console.log('4️⃣ Détection langue...');
    const lang = await detectLanguage('chhal taman ?');
    console.log(`   ✅ Langue: ${lang.trim()}\n`);

    console.log('5️⃣ Embeddings (512 dims)...');
    const emb = await embed('t-shirt bleu');
    console.log(`   ✅ Dimensions: ${emb.length}\n`);

    console.log('📊 Compteurs:', callCounts);
    console.log('\n🎉 Tous les endpoints fonctionnent !');
  } catch (e) {
    console.error('❌ Erreur:', e);
    process.exit(1);
  }
}

main();