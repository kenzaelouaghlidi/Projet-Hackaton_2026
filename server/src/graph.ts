import dotenv from 'dotenv';
dotenv.config();

import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  KenzaState,
  makeInitialState,
  orchestrateRequest,
} from './agents';

// ═══════════════════════════════════════════════════════════════
// ANNOTATION — Schéma du StateGraph
// Chaque champ est déclaré pour que LangGraph sache quoi persister
// ═══════════════════════════════════════════════════════════════
const KenzaStateAnnotation = Annotation.Root({
  request_id: Annotation<string>,
  client_id: Annotation<string>,
  conversation_id: Annotation<string | null>,
  raw_input: Annotation<string>,
  language: Annotation<string>,
  intent: Annotation<string>,
  intent_confidence: Annotation<number>,
  client_memory: Annotation<any>,
  cart: Annotation<any>,
  catalogue_results: Annotation<any[]>,
  stock_status: Annotation<any>,
  delivery_estimate: Annotation<any>,
  order_created: Annotation<any>,
  guardrail_violations: Annotation<string[]>,
  needs_human_review: Annotation<boolean>,
  escalation_reasons: Annotation<string[]>,
  graph_trace: Annotation<string[]>,
  tool_calls: Annotation<any[]>,
  errors: Annotation<string[]>,
  response: Annotation<string>,
});

// ═══════════════════════════════════════════════════════════════
// NŒUDS DU GRAPHE
// Chaque nœud ajoute son nom à graph_trace (traçabilité)
// ═══════════════════════════════════════════════════════════════

// Nœud principal — appelle l'orchestrateur complet
async function orchestrateNode(state: any): Promise<any> {
  state.graph_trace = [...(state.graph_trace || []), 'orchestrate_node'];

  // Appeler l'orchestrateur (qui gère les 5 agents)
  const finalState = await orchestrateRequest(
    state.client_id,
    state.raw_input,
    state.conversation_id
  );

  // Fusionner le résultat avec l'état actuel
  return {
    ...state,
    ...finalState,
    graph_trace: [...(state.graph_trace || []), ...(finalState.graph_trace || [])],
  };
}

// ═══════════════════════════════════════════════════════════════
// GRAPHE LANGGRAPH + CHECKPOINTER POSTGRES
// La mémoire longue par client (EX-04) est gérée par le checkpointer
// ═══════════════════════════════════════════════════════════════

let compiledGraph: any = null;
let checkpointer: PostgresSaver | null = null;

export async function initGraph() {
  if (compiledGraph) return compiledGraph;

  console.log('🔧 Initialisation du graphe LangGraph...');

  // Créer le checkpointer Postgres
  checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
  await checkpointer.setup(); // Crée les tables de checkpoint si absentes
  console.log('   ✅ Checkpointer Postgres initialisé');

  // Construire le graphe
  const builder = new StateGraph(KenzaStateAnnotation)
    .addNode('orchestrate', orchestrateNode)
    .addEdge(START, 'orchestrate')
    .addEdge('orchestrate', END);

  compiledGraph = builder.compile({ checkpointer });

  console.log('   ✅ Graphe compilé avec checkpointer');

  return compiledGraph;
}

// ═══════════════════════════════════════════════════════════════
// FONCTION PUBLIQUE — Appelée par l'API Fastify
// ═══════════════════════════════════════════════════════════════
export async function handleMessage(
  clientId: string,
  message: string,
  conversationId: string | null = null
): Promise<KenzaState> {
  const graph = await initGraph();

  const initialState = makeInitialState(clientId, message, conversationId);

  // Thread ID = clientId → mémoire longue par client (EX-04)
  const config = {
    configurable: {
      thread_id: clientId,
    },
  };

  const result = await graph.invoke(initialState, config);

  return result as KenzaState;
}

// ═══════════════════════════════════════════════════════════════
// FONCTION DE LECTURE — Récupérer la mémoire d'un client
// ═══════════════════════════════════════════════════════════════
export async function getClientMemory(clientId: string): Promise<any> {
  const graph = await initGraph();
  const config = {
    configurable: {
      thread_id: clientId,
    },
  };

  try {
    const state = await graph.getState(config);
    return state?.values || null;
  } catch {
    return null;
  }
}