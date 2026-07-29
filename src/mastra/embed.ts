import { VoyageAIClient } from 'voyageai';
import type { VoyageTextEmbeddingConfig, VoyageTextModel } from '@mastra/voyageai';
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
 * model set lifted that restriction, and the app moved to the text endpoint.
 *
 * WHY THE RUNTIME IS STILL THE RAW SDK, now that `@mastra/voyageai@0.4.0` has shipped. That release
 * resolved both objections recorded here — `baseUrl` is a first-class config field (its own doc comment
 * names `https://ai.mongodb.com/v1`), and the multimodal input-shape bug is fixed (`toSdkContent` emits
 * `{type:'text',text}`, not a bare string). The types below are the library's now. But the *text*
 * embedder is still not usable on this path:
 *   - The native dep did not go away, it MOVED. `VoyageTextEmbeddingModelV3.doEmbed` delegates to V2,
 *     whose `doEmbed` calls `createTokenAwareBatches` -> `client.tokenize()` unconditionally (no
 *     bypass, not even for a single short string). That resolves `@huggingface/transformers` through
 *     `voyageai`'s **optional** peer, so `pnpm install` succeeds with no warning and it throws at the
 *     first embed — a worse failure mode than the old hard dependency, not a better one.
 *   - Cost of satisfying it: ~521 MB (`@huggingface/transformers` 263 MB + `onnxruntime-node` 258 MB)
 *     plus a first-call fetch of the tokenizer from huggingface.co. That fetch is the disqualifier: a
 *     cold `embedQuery` on the Track B box would reach out to huggingface.co BEFORE it can embed
 *     anything, and that box is VPN-restricted. `embed.test.ts` guards their absence.
 *   - The dep-free `voyageMultimodalEmbedding` route (what the earlier integration on
 *     `integrate/mastra-fork-library` used) no longer reaches this model: `MULTIMODAL_MODEL_INFO`
 *     covers only `voyage-multimodal-3` and `-3.5`, not `voyage-4`.
 *
 * The vectors are not the issue and never were: the library builds the same `VoyageAIClient` and calls
 * the same `client.embed` with the same `baseUrl`, so for a matched model and `inputType` the wire
 * request is identical and the embeddings are bit-identical (measured 0.00e+0 difference against the
 * MongoDB gateway). If the tokenizer dependency is ever dropped or made lazy, this file can move to
 * `createVoyageTextEmbedding` with NO re-embedding. Until then the trade is dependency weight only.
 *
 * There IS a dep-free runtime surface worth taking: `createVoyageReranker` / `VoyageRelevanceScorer`
 * only ever call `client.rerank`, never `tokenize`, and accept the same `baseUrl`. Not wired yet.
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
/**
 * Typed as the library's `VoyageTextModel` union rather than a bare string, so a typo becomes a
 * compile error instead of a P@1 = 0.10 incident (see the re-embedding warning below).
 */
export const EMBED_MODEL: VoyageTextModel = 'voyage-4';
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

/**
 * The client the embedder runs on, configured through `@mastra/voyageai`'s typed contract.
 *
 * `baseUrl` used to need an `as any`, so the one field that makes the MongoDB-hosted gateway reachable
 * was the one field the compiler could not check. It turns out the raw SDK did declare it all along
 * (`BaseClientOptions.baseUrl`, as a `Supplier<string>`), so the cast was never load-bearing — dropping
 * it restores checking on `apiKey` too.
 *
 * `satisfies Pick<VoyageTextEmbeddingConfig, ...>` on top of that pins the field names to
 * `@mastra/voyageai`'s own config type, so if the library ever renames `baseUrl` this call site fails
 * to compile instead of quietly diverging from the package the demo claims to use. `Pick` asserts only
 * the fields actually passed, so it cannot drift into claiming the library constructs the client.
 *
 * It must be `satisfies` on a literal, NOT an annotated intermediate variable. Assigning through a
 * variable strips object-literal freshness, and the constructor's excess-property check goes with it:
 * `Pick<..., 'apiKey'|'model'>` then compiles even though `model` is not a `BaseClientOptions` field
 * at all (verified both ways). That form type-checks the library's contract while silently asserting
 * nothing about the SDK's — a cast wearing a type annotation. `satisfies` keeps freshness, so this
 * literal is checked against both shapes.
 */
function voyageClient(cfg: Config): VoyageAIClient {
  return new VoyageAIClient({
    apiKey: cfg.voyageApiKey,
    baseUrl: resolveVoyageBaseUrl(cfg),
  } satisfies Pick<VoyageTextEmbeddingConfig, 'apiKey' | 'baseUrl'>);
}

/** Construct a VoyageEmbedder backed by a live VoyageAIClient from config. */
export function getQueryEmbedder(cfg: Config): VoyageEmbedder {
  return createVoyageEmbedder({ client: voyageClient(cfg) as unknown as TextEmbedClient, model: EMBED_MODEL });
}
