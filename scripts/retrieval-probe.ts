/**
 * Retrieval-quality probe: does vector/hybrid search return the RIGHT precedents?
 *
 * Purpose is comparative — run it before and after an embedding-model change to prove retrieval did
 * not silently degrade. Changing the model keeps dimensions at 1024, so nothing errors and the app
 * looks healthy; only the ranking gets worse. This makes that visible.
 *
 * For each probe query we know which lane the top hits SHOULD belong to, so the metric is
 * precision@k over lane labels plus the raw top-k for eyeballing. No LLM involved, so it is fast and
 * deterministic enough to compare across runs.
 *
 * Read-only. Usage: npx tsx scripts/retrieval-probe.ts [--json]
 */
import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { createVoyageEmbedder, resolveVoyageBaseUrl, EMBED_MODEL } from '../src/mastra/embed';
import { RetrievalService } from '../src/retrieval/service';
import { VoyageAIClient } from 'voyageai';

const K = 5;

/**
 * `--model=X` embeds the probe QUERIES with X instead of the configured default. Used to measure the
 * old model against the old corpus before a re-embed, so before/after is an apples-to-apples
 * comparison rather than "new query model vs old document vectors" (which is the broken state we are
 * trying to avoid, not a baseline).
 */
function modelArg(): string {
  const a = process.argv.find(x => x.startsWith('--model='));
  return a ? a.slice('--model='.length) : EMBED_MODEL;
}

/** Query → the lane its top hits should come from. Phrased like a real investigator would. */
const PROBES = [
  { q: 'cash deposit just under the 5000 dollar reporting threshold, repeated sub-threshold pattern', lane: 'structuring' },
  { q: 'counterparty matched a sanctions watchlist screening hit', lane: 'sanctions' },
  { q: 'circular money flow through mule accounts, layering network', lane: 'ring' },
  { q: 'high value wire transfer at or above fifty thousand dollars', lane: 'high_value' },
  { q: 'card not present charge to an unrecognized merchant after a foreign login', lane: 'clear_reject' },
  { q: 'routine recurring payroll deposit from a long standing employer', lane: 'clean_approve' },
];

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  const db = client.db(cfg.mongoDb);
  const model = modelArg();
  // Multimodal models must go to a different endpoint, so the old baseline needs the raw call shape.
  const voyage = new VoyageAIClient({ apiKey: cfg.voyageApiKey, baseUrl: resolveVoyageBaseUrl(cfg) } as any);
  const isMultimodal = model.includes('multimodal');
  const emb = isMultimodal
    ? {
      async embedQuery(q: string) {
        const res: any = await (voyage as any).multimodalEmbed({
          inputs: [{ content: [{ type: 'text', text: q }] }], model, inputType: 'query',
        });
        return res?.data?.[0]?.embedding ?? [];
      },
    }
    : createVoyageEmbedder({ client: voyage as any, model });
  const svc = new RetrievalService(db, t => emb.embedQuery(t));

  // Measure vector AND hybrid separately: hybrid blends in BM25, which would partly mask a purely
  // vector-side regression. The embedding model only moves the vector leg directly.
  const rows: any[] = [];
  for (const p of PROBES) {
    const vHits = await svc.vector(p.q, K);
    const hHits = await svc.hybrid(p.q, K);
    const prec = (hits: { lane: string }[]) =>
      Number((hits.filter(h => h.lane === p.lane).length / K).toFixed(2));
    rows.push({
      lane: p.lane,
      vector_p: prec(vHits), hybrid_p: prec(hHits),
      vector_lanes: vHits.map(h => h.lane), hybrid_lanes: hHits.map(h => h.lane),
      hybrid_ids: hHits.map(h => h.transaction_id),
    });
  }

  const meanOf = (key: string) => Number((rows.reduce((a, r) => a + r[key], 0) / rows.length).toFixed(4));
  const summary = {
    model, k: K,
    mean_vector_precision: meanOf('vector_p'),
    mean_hybrid_precision: meanOf('hybrid_p'),
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...summary, probes: rows }, null, 2));
  } else {
    console.log(`model=${summary.model}  mean vector p@${K}=${summary.mean_vector_precision}  mean hybrid p@${K}=${summary.mean_hybrid_precision}\n`);
    for (const r of rows) {
      console.log(`${r.lane.padEnd(14)} vec=${r.vector_p} hyb=${r.hybrid_p}  vec:[${r.vector_lanes.join(',')}]`);
    }
  }
  await client.close();
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
