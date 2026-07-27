/**
 * `estimatedDocumentCount` with a 0 fallback, for code that only needs to know roughly how big a
 * collection is (which side of a threshold it falls on) and must never fail because it asked.
 *
 * Two call sites size a decision by corpus scale — the vector index's quantization
 * (`provision-transactions.ts`) and the search self-check's retry window
 * (`search-self-check.ts`) — and both run during provisioning, where an unexpected throw aborts a
 * deploy over a diagnostic. `.catch()` alone is not enough: a collection object without the method
 * throws a synchronous TypeError before any promise exists, which is exactly what the unit-test
 * fakes do. 0 is the safe answer in both cases: it selects unquantized and the short retry window,
 * i.e. the behaviour these call sites had before they consulted the count at all.
 */
export async function estimatedCount(col: { estimatedDocumentCount?: () => Promise<number> }): Promise<number> {
  try {
    return (await col.estimatedDocumentCount?.()) ?? 0;
  } catch {
    return 0;
  }
}
