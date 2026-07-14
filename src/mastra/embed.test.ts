import { describe, it, expect } from 'vitest';
import {
  buildMultimodalInputs, createVoyageEmbedder, resolveVoyageBaseUrl,
  MONGODB_VOYAGE_BASE_URL, type MultimodalEmbedClient,
} from './embed';

describe('embed', () => {
  it('wraps text into object-shaped multimodal inputs', () => {
    expect(buildMultimodalInputs(['hi'])).toEqual([{ content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('embedQuery returns the vector for index 0', async () => {
    const client: MultimodalEmbedClient = {
      async multimodalEmbed() { return { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }; },
    };
    const emb = createVoyageEmbedder({ client });
    expect(await emb.embedQuery('q')).toEqual([0.1, 0.2, 0.3]);
  });

  it('defaults to the MongoDB-hosted Voyage endpoint', () => {
    expect(resolveVoyageBaseUrl({ voyageBaseUrl: undefined } as any)).toBe(MONGODB_VOYAGE_BASE_URL);
    expect(resolveVoyageBaseUrl({ voyageBaseUrl: 'https://custom' } as any)).toBe('https://custom');
  });
});
