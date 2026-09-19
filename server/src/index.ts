import dotenv from 'dotenv';
dotenv.config();

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { handleMessage } from './graph';
import { db } from './db';
import { startFollowupWorker } from './worker';

const app = Fastify({ logger: true });

async function start() {
  // ═══ CORS ═══
  await app.register(cors, { origin: true });

  // ═══════════════════════════════════════════════════════════════
  // ROUTE CHAT — Reçoit un message client
  // EX-01 : conversation bout en bout
  // ═══════════════════════════════════════════════════════════════
  app.post('/chat', async (request, reply) => {
    const { message, clientId, conversationId } = request.body as {
      message: string;
      clientId: string;
      conversationId?: string;
    };

    console.log(`📩 [${clientId}] ${message}`);

    try {
      const state = await handleMessage(clientId, message, conversationId || null);

      return {
        response: state.response,
        intent: state.intent,
        language: state.language,
        needs_human_review: state.needs_human_review,
        escalation_reasons: state.escalation_reasons,
        graph_trace: state.graph_trace,
        tool_calls_count: state.tool_calls.length,
      };
    } catch (e: any) {
      console.error('❌ Erreur chat:', e);
      return reply.status(500).send({
        error: 'chat_failed',
        message: e.message,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ROUTE DASHBOARD — Statistiques réelles
  // EX-07 : conversations, taux de conversion, commandes, escalades
  // ═══════════════════════════════════════════════════════════════
  app.get('/dashboard/stats', async () => {
    const [conv, orders, esc, confirmed] = await Promise.all([
      db.query(`SELECT COUNT(DISTINCT client_id) AS c FROM conversations`),
      db.query(`SELECT COUNT(*) AS c FROM orders WHERE date >= CURRENT_DATE - INTERVAL '30 days'`),
      db.query(`SELECT COUNT(*) AS c FROM escalations WHERE status = 'pending'`),
      db.query(`SELECT COUNT(*) AS c FROM orders WHERE statut IN ('livrée', 'en préparation')`),
    ]);

    const conversations = parseInt(conv.rows[0].c);
    const ordersCount = parseInt(orders.rows[0].c);
    const escalations = parseInt(esc.rows[0].c);
    const confirmedOrders = parseInt(confirmed.rows[0].c);

    const conversion = conversations > 0
      ? Math.round((confirmedOrders / conversations) * 100)
      : 0;

    return {
      conversations_count: conversations,
      orders_count: ordersCount,
      escalations_count: escalations,
      conversion_rate: conversion,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // ROUTE ESCALATIONS — File HITL
  // EX-06 : escalade humaine
  // ═══════════════════════════════════════════════════════════════
  app.get('/dashboard/escalations', async () => {
    const result = await db.query(
      `SELECT id, client_id, reason, context, status, created_at
       FROM escalations
       WHERE status = 'pending'
       ORDER BY created_at DESC
       LIMIT 50`
    );
    return { escalations: result.rows };
  });

  // ═══════════════════════════════════════════════════════════════
  // ROUTE PRODUITS — Pour debug / démo
  // ═══════════════════════════════════════════════════════════════
  app.get('/products', async () => {
    const result = await db.query(
      `SELECT ref, modele, famille, couleur, taille, prix_mad, stock
       FROM products
       ORDER BY ref
       LIMIT 20`
    );
    return { products: result.rows };
  });

  // ═══════════════════════════════════════════════════════════════
  // DÉMARRAGE
  // ═══════════════════════════════════════════════════════════════
  const PORT = parseInt(process.env.PORT || '3000');

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 API Kenza démarrée sur http://localhost:${PORT}`);

    // Démarrer le worker BullMQ pour les relances (EX-05)
    startFollowupWorker();
    console.log(`🔔 Worker BullMQ actif`);
  } catch (e) {
    console.error('❌ Erreur au démarrage:', e);
    process.exit(1);
  }
}

start();