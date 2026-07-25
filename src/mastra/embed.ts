import { VoyageAIClient } from 'voyageai';
import type { Config } from '../config';

/**
 * Voyage embeddings for the `transactions` corpus, routed through the MongoDB-hosted Voyage endpoint
 * (`https://ai.mongodb.com/v1`) so the Atlas-scoped VOYAGE_API_KEY authenticates.
 *
 * We use the TEXT embedding endpoint (`client.embed`) with `voyage-3.5`. The corpus is plain-text
 * narratives, so a text model is the natural fit and also the fastest available: benchmarked in-region
 * on the app box (2026-07), median query-embed latency was 138 ms for `voyage-3.5` vs 183 ms for
 * `voyage-multimodal-3.5`, with no overlap between samples.
 *
 * History, because it explains why this file drives the raw SDK instead of `@mastra/voyageai`: it used
 * to call `multimodalEmbed` with `voyage-multimodal-3.5`, because the original Atlas-scoped key could
 * only reach three multimodal models through the gateway (every text model 400'd). A key with the full
 * model set lifted that restriction. The reasons for avoiding the official Mastra embedder still hold:
 *   - `@mastra/voyageai`'s text embedder needs `@huggingface/transformers` for token-aware batching
 *     (a heavy native dep) and throws without it.
 *   - `VoyageMultimodalEmbeddingModel.doEmbed` serializes text content to bare strings, producing
 *     `inputs: [["text"]]`, which the multimodal API rejects ("Expected object. Received list").
 * Revisit if @mastra/voyageai adds a base-URL passthrough and drops the native dep.
 *
 * Changing EMBED_MODEL requires re-embedding the whole corpus: query and document vectors must come
 * from the same model or retrieval silently degrades. Dimensions still match, so nothing errors — the
 * results just get quietly worse. Use `npm run reembed` (scripts/reembed-corpus.ts).
 */
export const EMBED_MODEL = 'voyage-3.5';
export const MONGODB_VOYAGE_BASE_URL = 'https://ai.mongodb.com/v1';

/** Minimal structural view of the SDK method we depend on (keeps the unit test hermetic). */
export interface TextEmbedClient {
  embed(request: {
    input: string[]; model: string; inputType?: 'query' | 'document';
  }): Promise<{ data?: { index?: number; embedding?: number[] }[] }>;
}

export interface VoyageEmbedder {
  embedQuery(query: string): Promise<number[]>;
  /** Batch-embed corpus documents (chunked, order-preserving). */
  embedDocuments(texts: string[]): Promise<number[][]>;
}

/**
 * Max inputs per embed request. The text endpoint's documented list limit is 128; we stay under it.
 * A per-request token ceiling also applies, which these short narratives are nowhere near.
 */
export const EMBED_BATCH_SIZE = 96;

export function createVoyageEmbedder(deps: { client: TextEmbedClient; model?: string }): VoyageEmbedder {
  const model = deps.model ?? EMBED_MODEL;
  return {
    async embedQuery(query: string): Promise<number[]> {
      const res = await deps.client.embed({ input: [query], model, inputType: 'query' });
      const rows = res.data ?? [];
      const first = rows.find(r => (r.index ?? 0) === 0) ?? rows[0];
      return first?.embedding ?? [];
    },
    async embedDocuments(texts: string[]): Promise<number[][]> {
      const out: number[][] = new Array(texts.length);
      for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
        const chunk = texts.slice(start, start + EMBED_BATCH_SIZE);
        const res = await deps.client.embed({ input: chunk, model, inputType: 'document' });
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
  return createVoyageEmbedder({ client: voyageClient(cfg) as unknown as TextEmbedClient, model: EMBED_MODEL });
}
