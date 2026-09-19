import dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';

// ═══ GPT-5.5 — Raisonnement ═══
export const reasoningLLM = new OpenAI({
  baseURL: process.env.LLM_URL!,
  apiKey: process.env.LLM_API_KEY!,
});
export const REASONING_MODEL = process.env.LLM_MODEL || 'gpt-5.5';

// ═══ GPT-4.1 — Volume ═══
export const volumeLLM = new OpenAI({
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT_NAME}`,
  apiKey: process.env.AZURE_OPENAI_API_KEY!,
  defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION! },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY! },
});
export const VOLUME_MODEL = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-4.1';

// ═══ Embeddings ═══
export const embeddingClient = new OpenAI({
  baseURL: process.env.LLM_URL!,
  apiKey: process.env.LLM_API_KEY!,
});
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'embedder-small-3';
export const EMBEDDING_DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS || '512');

// ═══ Compteurs d'appels ═══
export const callCounts = { reasoning: 0, volume: 0, embedding: 0 };

// ═══ GPT-5.5 — Raisonnement profond ═══
export async function reason(
  systemPrompt: string,
  userPrompt: string,
  options: { maxTokens?: number; json?: boolean } = {}
): Promise<string> {
  callCounts.reasoning++;
  const response = await reasoningLLM.chat.completions.create({
    model: REASONING_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_completion_tokens: options.maxTokens ?? 2000,
    ...(options.json && { response_format: { type: 'json_object' } }),
  });
  return response.choices[0].message.content || '';
}

// ═══ GPT-4.1 — Volume ═══
export async function execute(
  systemPrompt: string,
  userPrompt: string,
  options: { maxTokens?: number; json?: boolean } = {}
): Promise<string> {
  callCounts.volume++;
  const response = await volumeLLM.chat.completions.create({
    model: VOLUME_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: options.maxTokens ?? 1024,
    ...(options.json && { response_format: { type: 'json_object' } }),
  });
  return response.choices[0].message.content || '';
}

// ═══ Embeddings (1 texte) ═══
export async function embed(text: string): Promise<number[]> {
  callCounts.embedding++;
  const response = await embeddingClient.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

// ═══ Embeddings (batch — pour indexation massive) ═══
export async function embedBatch(texts: string[]): Promise<number[][]> {
  callCounts.embedding++;
  const response = await embeddingClient.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data.map((d) => d.embedding);
}

// ═══ Classification d'intention ═══
export async function classifyIntent(message: string): Promise<string> {
  return execute(
    `Classifie l'intention parmi : prix_et_disponibilite, rupture_de_stock,
     conseil_taille, negociation, question_arabe, client_qui_revient,
     changement_avis, note_vocale, photo_produit, suivi_commande,
     retour_produit, hors_domaine, livraison_arabe, rupture_arabe,
     reclamation_arabe, panier_abandonne, darija_prix, out_of_scope.
     Réponds UNIQUEMENT par le nom de l'intention.`,
    message,
    { maxTokens: 30 }
  );
}

// ═══ Détection de langue ═══
export async function detectLanguage(message: string): Promise<string> {
  return execute(
    `Détecte la langue : fr, ar, ou darija. Réponds UNIQUEMENT par le code.`,
    message,
    { maxTokens: 5 }
  );
}