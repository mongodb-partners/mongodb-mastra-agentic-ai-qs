import type { Transaction, Lane, DecidedStatus } from '../mastra/schemas/transactions';

/**
 * Synthetic decided-precedent corpus — the "deployment at scale" story. Every record is a
 * DECIDED historical transaction (never pending, so it can't enter the live queue), embedded and
 * indexed like the curated seeds, so hybrid/vector/full-text retrieval and $graphLookup genuinely
 * run over a corpus of thousands, not fifteen.
 *
 * Deterministic: same (count, seed) → byte-identical corpus. Provisioning stays idempotent and
 * the generator is unit-testable without a database.
 */

export const SYNTHETIC_ID_PREFIX = 'txn-syn-';

export type SyntheticTransaction = Omit<Transaction, 'embedding'>;

/** mulberry32 — tiny deterministic PRNG; good enough for fixture variety. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPANIES = [
  'Northwind Foods', 'Cascade Textiles', 'Ironvale Logistics', 'Bluepeak Analytics', 'Halcyon Motors',
  'Sable Ridge Farms', 'Quanta Fabrication', 'Peregrine Freight', 'Copperline Utilities', 'Vantage Retail Group',
  'Stoneharbor Imports', 'Aurora Med Supplies', 'Kestrel Aviation Parts', 'Marrow & Finch LLP', 'Tidewater Seafood',
  'Redwood Office Systems', 'Glacier Cold Chain', 'Summit Roofing Co', 'Palisade Insurance Brokers', 'Orchid Cosmetics',
  'Foundry Metalworks', 'Lanternfish Media', 'Clearspring Water Co', 'Basalt Construction', 'Windrose Travel',
];
const PEOPLE = [
  'J. Rivera', 'M. Okafor', 'A. Lindqvist', 'P. Sandoval', 'T. Nakamura', 'R. Whitfield', 'S. Devlin',
  'K. Osei', 'L. Marchetti', 'D. Kowalski', 'N. Ferreira', 'H. Abadi', 'C. Beaumont', 'E. Vargas',
  'G. Petrov', 'B. Ashworth', 'F. Ngata', 'V. Iyer', 'W. Calloway', 'Y. Dominguez',
];
const CLEAN_PURPOSES = [
  'recurring payroll credit', 'quarterly vendor settlement', 'monthly SaaS subscription renewal',
  'invoice payment for delivered goods', 'utility bill autopay', 'insurance premium payment',
  'contract milestone payment', 'equipment lease installment', 'freight and customs settlement',
  'professional services retainer',
];
const REJECT_PATTERNS = [
  'card-not-present purchase at an unrecognized overseas merchant, cardholder disputes the charge',
  'account takeover pattern: password reset followed by an immediate transfer to a new payee',
  'first-party fraud: chargeback filed on goods confirmed delivered',
  'stolen-card testing pattern: burst of small authorizations then a large transfer',
  'payee added minutes before transfer, device fingerprint mismatch on session',
];
const HIGH_VALUE_PURPOSES = [
  'real-estate escrow settlement', 'M&A tranche payment', 'bulk commodity purchase',
  'fleet acquisition payment', 'annual reinsurance premium',
];
const SANCTIONS_NOTES = [
  'recipient matched a sanctions watchlist entry during screening',
  'counterparty bank domiciled in a comprehensively sanctioned jurisdiction',
  'beneficial owner appears on a designated-persons list',
];

const pick = <T>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const money = (n: number) => n.toLocaleString('en-US');

interface LaneSpec {
  lane: Lane; weight: number;
  gen(rng: () => number, i: number): { text: string; amount: number; sender: string; recipient: string; status: DecidedStatus };
}

const LANE_SPECS: LaneSpec[] = [
  {
    lane: 'clean_approve', weight: 55,
    gen(rng) {
      const amount = Math.round(120 + rng() * 9380);
      const sender = pick(rng, COMPANIES); const recipient = rng() < 0.5 ? pick(rng, PEOPLE) : pick(rng, COMPANIES);
      const purpose = pick(rng, CLEAN_PURPOSES);
      return {
        amount, sender, recipient, status: 'approved',
        text: `${purpose[0].toUpperCase()}${purpose.slice(1)} of ${money(amount)} USD from ${sender} to ${recipient}. Established relationship, consistent with prior activity, no anomalies.`,
      };
    },
  },
  {
    lane: 'clear_reject', weight: 15,
    gen(rng) {
      const amount = Math.round(180 + rng() * 2400);
      const sender = pick(rng, PEOPLE); const recipient = pick(rng, COMPANIES);
      return {
        amount, sender, recipient, status: 'rejected',
        text: `Transfer of ${money(amount)} USD from ${sender} to ${recipient}; ${pick(rng, REJECT_PATTERNS)}. Rejected as confirmed fraud.`,
      };
    },
  },
  {
    lane: 'structuring', weight: 10,
    gen(rng) {
      const amount = 4900 + Math.round(rng() * 99);
      const sender = pick(rng, COMPANIES); const recipient = rng() < 0.6 ? sender : pick(rng, COMPANIES);
      const nth = 2 + Math.floor(rng() * 4);
      return {
        amount, sender, recipient, status: rng() < 0.6 ? 'escalated' : 'rejected',
        text: `Cash deposit of ${money(amount)} USD just under the 5000 USD reporting threshold at ${sender}; deposit ${nth} in a repeated sub-threshold pattern this week. Flagged as structuring.`,
      };
    },
  },
  {
    lane: 'high_value', weight: 10,
    gen(rng) {
      const amount = Math.round(50_000 + rng() * 200_000);
      const sender = pick(rng, COMPANIES); const recipient = pick(rng, COMPANIES);
      return {
        amount, sender, recipient, status: rng() < 0.55 ? 'escalated' : 'approved',
        text: `High-value wire of ${money(amount)} USD from ${sender} to ${recipient} for a ${pick(rng, HIGH_VALUE_PURPOSES)}. Above the enhanced-due-diligence threshold; documentation reviewed.`,
      };
    },
  },
  {
    lane: 'ring', weight: 7,
    gen(rng) {
      const amount = Math.round(400 + rng() * 1600);
      const sender = pick(rng, COMPANIES); const recipient = pick(rng, COMPANIES);
      return {
        amount, sender, recipient, status: rng() < 0.7 ? 'rejected' : 'escalated',
        text: `Transfer of ${money(amount)} USD from ${sender} to ${recipient}, one hop in a rapid multi-account chain that returns funds near their origin. Consistent with mule-ring layering.`,
      };
    },
  },
  {
    lane: 'sanctions', weight: 3,
    gen(rng) {
      const amount = Math.round(5_000 + rng() * 55_000);
      const sender = pick(rng, COMPANIES); const recipient = pick(rng, COMPANIES);
      return {
        amount, sender, recipient, status: 'rejected',
        text: `Wire of ${money(amount)} USD from ${sender} to ${recipient}; ${pick(rng, SANCTIONS_NOTES)}. Deterministic compliance reject.`,
      };
    },
  },
];

const TOTAL_WEIGHT = LANE_SPECS.reduce((s, l) => s + l.weight, 0);

function laneFor(rng: () => number): LaneSpec {
  let roll = rng() * TOTAL_WEIGHT;
  for (const spec of LANE_SPECS) { roll -= spec.weight; if (roll <= 0) return spec; }
  return LANE_SPECS[0];
}

/** Timestamps spread across the 17 months BEFORE the curated seeds (May 2026), so curated demo
 *  cases always sort first in the queue's created_at-desc view. */
function timestampFor(rng: () => number): Date {
  const start = Date.UTC(2024, 11, 1); // 2024-12-01
  const end = Date.UTC(2026, 3, 30);   // 2026-04-30
  return new Date(start + rng() * (end - start));
}

/**
 * Ring lanes get REAL cycles: every 3 consecutive ring transactions share a 3-account loop
 * (A→B→C→A), so $graphLookup over the scaled corpus traverses genuine circular flows.
 */
export function generateSyntheticCorpus(count: number, seed = 42): SyntheticTransaction[] {
  const rng = mulberry32(seed);
  const out: SyntheticTransaction[] = [];
  let ringCursor = 0; // position within the current 3-txn ring cycle
  let ringGroup = 0;
  for (let i = 0; i < count; i++) {
    const spec = laneFor(rng);
    const g = spec.gen(rng, i);
    const id = `${SYNTHETIC_ID_PREFIX}${String(i + 1).padStart(5, '0')}`;
    let senderAcc = `ACC-SYN-${1000 + Math.floor(rng() * 9000)}`;
    let recipientAcc = `ACC-SYN-${1000 + Math.floor(rng() * 9000)}`;
    if (spec.lane === 'ring') {
      if (ringCursor === 0) ringGroup++;
      const ring = ['A', 'B', 'C'].map(s => `ACC-SYNRING-${ringGroup}${s}`);
      senderAcc = ring[ringCursor];
      recipientAcc = ring[(ringCursor + 1) % 3];
      ringCursor = (ringCursor + 1) % 3;
    }
    out.push({
      transaction_id: id,
      text: g.text,
      amount: g.amount,
      currency: 'USD',
      sender: { name: g.sender, account_number: senderAcc },
      recipient: { name: g.recipient, account_number: recipientAcc },
      status: g.status,
      lane: spec.lane,
      model_used: 'historical',
      created_at: timestampFor(rng),
    });
  }
  return out;
}
