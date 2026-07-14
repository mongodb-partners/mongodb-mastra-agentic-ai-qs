import { VoyageAIClient } from 'voyageai';
import type { Config } from '../config';

/**
 * Voyage embeddings for the `transactions` corpus, routed through the MongoDB-hosted Voyage endpoint
 * (`https://ai.mongodb.com/v1`) so the Atlas-scoped VOYAGE_API_KEY authenticates.
 *
 * We deliberately call the raw `voyageai` SDK's `multimodalEmbed` rather than the official
 * `@mastra/voyageai` embedder. Verified against the live MongoDB-hosted endpoint (2026-07):
 *   - `@mastra/voyageai`'s `VoyageMultimodalEmbeddingModel.doEmbed` serializes text content to bare
 *     strings, producing `inputs: [["text"]]`; the API requires `inputs: [{content:[{type,text}]}]`
 *     and 400s the array-of-strings shape ("Expected object. Received list").
 *   - `@mastra/voyageai`'s text embedder needs `@huggingface/transformers` for token-aware batching
 *     (a heavy native dep) and throws without it.
 * So the official embedder can't reach the MongoDB-hosted endpoint today. The raw SDK sends the exact
 * object shape the API accepts. Revisit if @mastra/voyageai adds a base-URL passthrough + fixes the
 * multimodal input shaping.
 */
export const MULTIMODAL_MODEL = 'voyage-multimodal-3.5';
export const MONGODB_VOYAGE_BASE_URL = 'https://ai.mongodb.com/v1';

export interface MultimodalInput { content: { type: 'text'; text: string }[]; }

/** Wrap plain text into the object-shaped inputs the Voyage multimodal API requires. */
export function buildMultimodalInputs(texts: string[]): MultimodalInput[] {
  return texts.map(text => ({ content: [{ type: 'text', text }] }));
}

/** Minimal structural view of the SDK method we depend on (keeps the unit test hermetic). */
export interface MultimodalEmbedClient {
  multimodalEmbed(request: {
    inputs: MultimodalInput[]; model: string; inputType?: 'query' | 'document';
  }): Promise<{ data?: { index?: number; embedding?: number[] }[] }>;
}

export interface VoyageEmbedder {
  embedQuery(query: string): Promise<number[]>;
  /** Batch-embed corpus documents (chunked, order-preserving). */
  embedDocuments(texts: string[]): Promise<number[][]>;
}

/** Max inputs per multimodalEmbed request — stays under the Voyage API batch limit. */
export const EMBED_BATCH_SIZE = 96;

export function createVoyageEmbedder(deps: { client: MultimodalEmbedClient; model?: string }): VoyageEmbedder {
  const model = deps.model ?? MULTIMODAL_MODEL;
  return {
    async embedQuery(query: string): Promise<number[]> {
      const res = await deps.client.multimodalEmbed({
        inputs: buildMultimodalInputs([query]), model, inputType: 'query',
      });
      const rows = res.data ?? [];
      const first = rows.find(r => (r.index ?? 0) === 0) ?? rows[0];
      return first?.embedding ?? [];
    },
    async embedDocuments(texts: string[]): Promise<number[][]> {
      const out: number[][] = new Array(texts.length);
      for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
        const chunk = texts.slice(start, start + EMBED_BATCH_SIZE);
        const res = await deps.client.multimodalEmbed({
          inputs: buildMultimodalInputs(chunk), model, inputType: 'document',
        });
        for (const [i, row] of (res.data ?? []).entries()) {
          out[start + (row.index ?? i)] = row.embedding ?? [];
        }
      }
      return out;
    },
  };
}

/** Resolve the Voyage base URL: explicit config wins, else the MongoDB-hosted default. */
export function resolveVoyageBaseUrl(cfg: Config): string {
  return cfg.voyageBaseUrl ?? MONGODB_VOYAGE_BASE_URL;
}

function voyageClient(cfg: Config): VoyageAIClient {
  return new VoyageAIClient({ apiKey: cfg.voyageApiKey, baseUrl: resolveVoyageBaseUrl(cfg) } as any);
}

/** Construct a VoyageEmbedder backed by a live VoyageAIClient from config. */
export function getQueryEmbedder(cfg: Config): VoyageEmbedder {
  return createVoyageEmbedder({ client: voyageClient(cfg) as unknown as MultimodalEmbedClient, model: MULTIMODAL_MODEL });
}
