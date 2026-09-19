import dotenv from 'dotenv';
dotenv.config();

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { db } from './db';
import { relanceAgent } from './agents';

// ═══════════════════════════════════════════════════════════════
// CONNEXION REDIS (partagée entre Queue et Worker)
// ═══════════════════════════════════════════════════════════════
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// ═══════════════════════════════════════════════════════════════
// FILE BULLMQ — Relances planifiées
// ═══════════════════════════════════════════════════════════════
export const followupQueue = new Queue('followups', { connection });

// Ajouter une relance planifiée
export async function scheduleFollowup(
  clientId: string,
  conversationId: string | null,
  cartSnapshot: any,
  delayHours: number
) {
  const delayMs = delayHours * 60 * 60 * 1000;
  const jobId = `followup:${clientId}:${Date.now()}`;

  await followupQueue.add(
    'relance',
    {
      clientId,
      conversationId,
      cartSnapshot,
    },
    {
      delay: delayMs,
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
    }
  );

  console.log(
    `📅 Relance planifiée pour ${clientId} dans ${delayHours}h (job ${jobId})`
  );

  // Enregistrer en base pour traçabilité
  await db.query(
    `INSERT INTO followups (client_id, conversation_id, cart_snapshot, scheduled_at, message_variant)
     VALUES ($1, $2, $3, NOW() + INTERVAL '${delayHours} hours', 'A')`,
    [clientId, conversationId, JSON.stringify(cartSnapshot)]
  );

  return jobId;
}

// ═══════════════════════════════════════════════════════════════
// WORKER — Traite les relances
// Exécuté par un processus séparé (voir index.ts)
// ═══════════════════════════════════════════════════════════════
export function startFollowupWorker() {
  const worker = new Worker(
    'followups',
    async (job: Job) => {
      const { clientId, conversationId, cartSnapshot } = job.data;

      console.log(`🔔 Traitement relance pour ${clientId}...`);

      // 1. Charger le client
      const customerResult = await db.query(
        `SELECT * FROM customers WHERE client_id = $1`,
        [clientId]
      );
      if (customerResult.rows.length === 0) {
        console.log(`   ⚠️ Client ${clientId} introuvable`);
        return { skipped: true, reason: 'client_not_found' };
      }
      const customer = customerResult.rows[0];

      // 2. Agent Relance (GPT-5.5 décide + GPT-4.1 rédige)
      const decision = await relanceAgent(cartSnapshot, customer);
      if (!decision) {
        console.log(`   ⏭️ Pas de relance (décision agent)`);
        return { skipped: true, reason: 'agent_declined' };
      }

      // 3. Enregistrer l'envoi en base
      await db.query(
        `UPDATE followups
         SET sent_at = NOW(), message_variant = $1
         WHERE client_id = $2 AND sent_at IS NULL
         ORDER BY scheduled_at DESC
         LIMIT 1`,
        [decision.angle, clientId]
      );

      console.log(`   ✅ Relance envoyée à ${clientId} : ${decision.message.slice(0, 60)}...`);

      // 4. Retourner le message (sera envoyé par l'API via WebSocket)
      return {
        sent: true,
        clientId,
        message: decision.message,
        angle: decision.angle,
      };
    },
    {
      connection,
      concurrency: 3,
    }
  );

  worker.on('completed', (job) => {
    console.log(`✅ Job ${job.id} terminé`);
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ Job ${job?.id} échoué:`, err.message);
  });

  console.log('🚀 Worker BullMQ démarré (file: followups)');
  return worker;
}

// ═══════════════════════════════════════════════════════════════
// SI exécuté directement (npx tsx src/worker.ts)
// ═══════════════════════════════════════════════════════════════
if (require.main === module) {
  startFollowupWorker();
  console.log('   En attente de jobs...');
}