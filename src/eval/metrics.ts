export type Disposition = 'approve' | 'reject' | 'escalate';

export interface EvalCase {
  transaction_id: string;
  lane: string;
  expected: Disposition;
  actual: Disposition;
}

export interface LaneMetrics { lane: string; support: number; correct: number; recall: number; }
export interface ClassMetrics { label: Disposition; precision: number; recall: number; f1: number; tp: number; fp: number; fn: number; }
export interface EvalReport {
  n: number;
  accuracy: number;
  perLane: LaneMetrics[];
  perClass: ClassMetrics[];
  confusion: Record<Disposition, Record<Disposition, number>>;
  fraudRecall: number; // recall over cases whose expected disposition is NOT approve
}

const LABELS: Disposition[] = ['approve', 'reject', 'escalate'];

function emptyConfusion(): Record<Disposition, Record<Disposition, number>> {
  const c = {} as Record<Disposition, Record<Disposition, number>>;
  for (const a of LABELS) { c[a] = { approve: 0, reject: 0, escalate: 0 }; }
  return c;
}

/** Compute precision/recall/F1 per class, per-lane recall, a confusion matrix, and fraud recall. */
export function scoreEval(cases: EvalCase[]): EvalReport {
  const confusion = emptyConfusion();
  for (const c of cases) confusion[c.expected][c.actual]++;

  const perClass: ClassMetrics[] = LABELS.map(label => {
    const tp = confusion[label][label];
    const fn = LABELS.reduce((s, a) => s + (a === label ? 0 : confusion[label][a]), 0);
    const fp = LABELS.reduce((s, e) => s + (e === label ? 0 : confusion[e][label]), 0);
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { label, precision: round(precision), recall: round(recall), f1: round(f1), tp, fp, fn };
  });

  const laneMap = new Map<string, { support: number; correct: number }>();
  for (const c of cases) {
    const e = laneMap.get(c.lane) ?? { support: 0, correct: 0 };
    e.support++; if (c.actual === c.expected) e.correct++;
    laneMap.set(c.lane, e);
  }
  const perLane: LaneMetrics[] = [...laneMap.entries()].map(([lane, e]) => ({
    lane, support: e.support, correct: e.correct, recall: round(e.correct / e.support),
  }));

  const correct = cases.filter(c => c.actual === c.expected).length;
  const fraudCases = cases.filter(c => c.expected !== 'approve');
  const fraudCaught = fraudCases.filter(c => c.actual !== 'approve').length;

  return {
    n: cases.length,
    accuracy: round(cases.length ? correct / cases.length : 1),
    perLane, perClass, confusion,
    fraudRecall: round(fraudCases.length ? fraudCaught / fraudCases.length : 1),
  };
}

function round(x: number): number { return Number(x.toFixed(4)); }
