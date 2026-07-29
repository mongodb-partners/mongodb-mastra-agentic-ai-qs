import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createVoyageEmbedder, resolveVoyageBaseUrl, EMBED_MODEL, EMBED_BATCH_SIZE,
  MONGODB_VOYAGE_BASE_URL, type TextEmbedClient,
} from './embed';

/** Records every request so the tests can assert on shape, model, and batching. */
function fakeClient(vec: (text: string) => number[] = t => [t.length]) {
  const calls: { input: string[]; model: string; inputType?: string }[] = [];
  const client: TextEmbedClient = {
    async embed(req) {
      calls.push({ input: req.input, model: req.model, inputType: req.inputType });
      return { data: req.input.map((t, i) => ({ index: i, embedding: vec(t) })) };
    },
  };
  return { client, calls };
}

describe('embed', () => {
  it('sends text as a plain string array to the text endpoint', async () => {
    const { client, calls } = fakeClient();
    await createVoyageEmbedder({ client }).embedQuery('hi');
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual(['hi']);
    expect(calls[0].model).toBe(EMBED_MODEL);
  });

  it('defaults to voyage-4', () => {
    expect(EMBED_MODEL).toBe('voyage-4');
  });

  it('uses ONE model for both queries and documents, so they cannot drift apart', async () => {
    // The P@1=0.10 failure mode is a document corpus embedded by one generation and queried by
    // another. It raises no error — dimensions still match. The only structural defence is that
    // there is a single constant, so assert the two paths really do send the same model.
    const { client, calls } = fakeClient();
    const emb = createVoyageEmbedder({ client });
    await emb.embedQuery('q');
    await emb.embedDocuments(['d']);
    expect(calls.map(c => c.model)).toEqual([EMBED_MODEL, EMBED_MODEL]);
  });

  it('embedQuery returns the vector for index 0 and tags the input as a query', async () => {
    const { client, calls } = fakeClient(() => [0.1, 0.2, 0.3]);
    const emb = createVoyageEmbedder({ client });
    expect(await emb.embedQuery('q')).toEqual([0.1, 0.2, 0.3]);
    expect(calls[0].inputType).toBe('query');
  });

  it('embedQuery picks index 0 even when rows arrive out of order', async () => {
    const client: TextEmbedClient = {
      async embed() {
        return { data: [{ index: 1, embedding: [9] }, { index: 0, embedding: [1] }] };
      },
    };
    expect(await createVoyageEmbedder({ client }).embedQuery('q')).toEqual([1]);
  });

  it('embedQuery returns an empty vector rather than throwing on an empty response', async () => {
    const client: TextEmbedClient = { async embed() { return {}; } };
    expect(await createVoyageEmbedder({ client }).embedQuery('q')).toEqual([]);
  });

  it('embedDocuments tags inputs as documents and preserves order', async () => {
    const { client, calls } = fakeClient(t => [t.length]);
    const out = await createVoyageEmbedder({ client }).embedDocuments(['a', 'bb', 'ccc']);
    expect(out).toEqual([[1], [2], [3]]);
    expect(calls[0].inputType).toBe('document');
  });

  it('embedDocuments chunks past the batch size and keeps global ordering', async () => {
    const { client, calls } = fakeClient(t => [Number(t)]);
    const texts = Array.from({ length: EMBED_BATCH_SIZE + 5 }, (_, i) => String(i));
    const out = await createVoyageEmbedder({ client }).embedDocuments(texts);
    expect(calls).toHaveLength(2);
    expect(calls[0].input).toHaveLength(EMBED_BATCH_SIZE);
    expect(calls[1].input).toHaveLength(5);
    // Each row must land at its GLOBAL position, not its within-chunk index.
    expect(out).toEqual(texts.map(t => [Number(t)]));
  });

  it('stays within the text endpoint documented list limit of 128', () => {
    expect(EMBED_BATCH_SIZE).toBeLessThanOrEqual(128);
  });

  it('defaults to the MongoDB-hosted Voyage endpoint', () => {
    expect(resolveVoyageBaseUrl({ voyageBaseUrl: undefined } as any)).toBe(MONGODB_VOYAGE_BASE_URL);
    expect(resolveVoyageBaseUrl({ voyageBaseUrl: 'https://custom' } as any)).toBe('https://custom');
  });

  describe('the tokenizer dependency stays out of the dependency tree', () => {
    // WHY THIS TEST EXISTS. `@mastra/voyageai` is a real dependency here, but only for its types and
    // its reranker. The obvious "finish the job" change — swapping this file's raw `client.embed` for
    // `createVoyageTextEmbedding` — puts a huggingface.co ROUND TRIP ON THE LIVE QUERY PATH:
    // `VoyageTextEmbeddingModelV3.doEmbed` delegates to V2, whose `doEmbed` calls
    // `createTokenAwareBatches` -> `client.tokenize()` unconditionally, which needs
    // `@huggingface/transformers` and fetches the tokenizer from huggingface.co on first call. The
    // Track B box is VPN-restricted, so that first `embedQuery` would hang or fail there and nowhere
    // else. It is also ~521MB of node_modules (`@huggingface/transformers` 263MB + `onnxruntime-node`
    // 258MB).
    //
    // What makes it worth a test rather than a comment: `voyageai` lists the tokenizer as an
    // OPTIONAL peer, so adding the embedder produces no install warning and no type error — it
    // type-checks, installs clean, and throws at the first embed. This assertion is the only place
    // that failure becomes visible before deploy.
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };

    it.each(['@huggingface/transformers', 'onnxruntime-node'])('does not depend on %s', dep => {
      expect(declared).not.toHaveProperty(dep);
    });

    it('keeps @mastra/voyageai itself, since the types and the reranker are dep-free', () => {
      // The reranker (`client.rerank`) never tokenizes, so the package earns its place; this guards
      // against "fixing" the above by dropping the dependency altogether.
      expect(pkg.dependencies).toHaveProperty('@mastra/voyageai');
    });
  });
});
