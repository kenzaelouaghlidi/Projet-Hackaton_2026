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
// ═══════════════════════════════════════════════════════════════
const KenzaStateAnnotation = Annotation.Root({
  request_id: Annotation<string>,
  client_id: Annotation<string>,
  conversation_id: Annotation<string | null>,
  raw_input: Annotation<string>,
  language: Annotation<string>,
  preferred_language: Annotation<string>,
  intent: Annotation<string>,
  intent_confidence: Annotation<number>,
  client_memory: Annotation<any>,
  cart: Annotation<any>,
  current_product: Annotation<any>,
  current_family: Annotation<string>,
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
// NŒUD PRINCIPAL
// ═══════════════════════════════════════════════════════════════
async function orchestrateNode(state: any): Promise<any> {
  state.graph_trace = [...(state.graph_trace || []), 'orchestrate_node'];

  const finalState = await orchestrateRequest(
    state.client_id,
    state.raw_input,
    state.conversation_id,
    state.preferred_language  // passer la langue préférée
  );

  return {
    ...state,
    ...finalState,
    graph_trace: [
      ...(state.graph_trace || []),
      ...(finalState.graph_trace || []),
    ],
  };
}

// ═══════════════════════════════════════════════════════════════
// GRAPHE LANGGRAPH + CHECKPOINTER POSTGRES
// ═══════════════════════════════════════════════════════════════
let compiledGraph: any = null;
let checkpointer: PostgresSaver | null = null;

export async function initGraph() {
  if (compiledGraph) return compiledGraph;

  console.log('🔧 Initialisation du graphe LangGraph...');

  checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
  await checkpointer.setup();
  console.log('   ✅ Checkpointer Postgres initialisé');

  const builder = new StateGraph(KenzaStateAnnotation)
    .addNode('orchestrate', orchestrateNode)
    .addEdge(START, 'orchestrate')
    .addEdge('orchestrate', END);

  compiledGraph = builder.compile({ checkpointer });

  console.log('   ✅ Graphe compilé avec checkpointer');

  return compiledGraph;
}

// ═══════════════════════════════════════════════════════════════
// FONCTION PUBLIQUE
// ⚠️ CORRECTION 1 : thread_id par CONVERSATION (pas par client)
// ═══════════════════════════════════════════════════════════════
export async function handleMessage(
  clientId: string,
  message: string,
  conversationId: string | null = null
): Promise<KenzaState> {
  const graph = await initGraph();

  // ⭐ CORRECTION : thread_id = conversationId (contexte de la conv)
  // Si pas de conversationId, génère un basé sur clientId + timestamp
  const threadId = conversationId || `conv-${clientId}-${Date.now()}`;

  const initialState = makeInitialState(clientId, message, threadId);

  const config = {
    configurable: {
      thread_id: threadId,  // ⭐ 1 thread par conversation
    },
  };

  const result = await graph.invoke(initialState, config);

  return result as KenzaState;
}

// ═══════════════════════════════════════════════════════════════
// LECTURE MÉMOIRE
// ═══════════════════════════════════════════════════════════════
export async function getClientMemory(threadId: string): Promise<any> {
  const graph = await initGraph();
  const config = {
    configurable: {
      thread_id: threadId,
    },
  };

  try {
    const state = await graph.getState(config);
    return state?.values || null;
  } catch {
    return null;
  }
}