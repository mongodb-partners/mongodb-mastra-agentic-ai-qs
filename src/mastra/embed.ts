import { VoyageAIClient } from 'voyageai';
import type { Config } from '../config';

/**
 * Voyage embeddings for the `transactions` corpus, routed through the MongoDB-hosted Voyage endpoint
 * (`https://ai.mongodb.com/v1`) so the Atlas-scoped VOYAGE_API_KEY authenticates.
 *
 * We use the TEXT embedding endpoint (`client.embed`) with `voyage-4`. The corpus is plain-text
 * narratives, so a text model is the natural fit and also the fastest available.
 *
 * Measured ON THE TRACK B BOX — laptop numbers are inflated ~3x by the WAN leg and invert model
 * comparisons, so never benchmark this from a laptop. Query-embed p50 through the MongoDB gateway:
 * `voyage-4` 104 ms, `voyage-4-large` 106 ms, `voyage-4-lite` 108 ms. Batch throughput at 1024 dims
 * is ~0.60 h per million documents. Retrieval accuracy across the voyage-3.5 and voyage-4 families
 * is a measured tie (every paired-bootstrap 95% CI on the P@1 delta spans zero at n=60); the reason
 * to be on `voyage-4` is that this is a MongoDB partner demo and it is the current generation of the
 * MongoDB-hosted models.
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
 * CHANGING THIS CONSTANT REQUIRES RE-EMBEDDING EVERY STORED VECTOR IN THE SAME COMMIT. Query and
 * document vectors must come from the same generation. Cross-generation does not error and does not
 * warn — dimensions still match — it just returns the wrong neighbours: voyage-3.5 documents queried
 * with voyage-4 measured P@1 = 0.10, worse than random. Run `npm run reembed`
 * (scripts/reembed-corpus.ts) against every corpus before shipping a change here.
 *
 * Matched on both sides rather than split (large documents / lite queries): that split was the worst
 * cell of the 3x3 model grid on both P@3 and MRR, there is no query-latency win to harvest (104 vs
 * 108 ms), and a second constant is a second thing that can silently drift into the P@1=0.10 failure.
 * `EMBED_DIM` stays 1024 across the voyage-4 family, so a model change needs no index rebuild.
 */
export const EMBED_MODEL = 'voyage-4';
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
