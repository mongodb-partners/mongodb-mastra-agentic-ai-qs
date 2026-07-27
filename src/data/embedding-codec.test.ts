import { describe, it, expect } from 'vitest';
import { Binary } from 'mongodb';
import { toBinData, fromBinData, toFloat32Bytes, vectorByteLength } from './embedding-codec';
import { EMBED_DIM } from '../mastra/schemas/transactions';

describe('embedding codec', () => {
  it('round-trips a vector through float32 BinData', () => {
    // These values are all float32-exact, so the round-trip is lossless for this sample.
    const vec = [0, 1, -1, 0.5, 0.25];
    const bin = toBinData(vec);
    expect(bin).toBeInstanceOf(Binary);
    expect(bin.buffer.length).toBe(vectorByteLength(vec.length)); // 4 bytes/element, not 8
    expect(fromBinData(bin)).toEqual(vec);
  });

  it('emits BSON binary subtype 9, without which Atlas returns zero hits and no error', () => {
    // Measured on M30 2026-07-27: 1,000 documents stored as subtype 0 against a READY queryable
    // 1024-dim index returned an EMPTY $vectorSearch result and raised nothing. Atlas indexes the
    // vector subtype and silently ignores generic binary. This assertion is the regression guard.
    const bin = toBinData([1, 2, 3]);
    expect(bin.sub_type).toBe(Binary.SUBTYPE_VECTOR);
    // The 2-byte dtype header Atlas reads to know the element type: 0x27 = float32, then padding.
    expect([...bin.buffer.subarray(0, 2)]).toEqual([0x27, 0x00]);
  });

  it('still decodes a legacy subtype-0 payload, so a pre-fix corpus reads back', () => {
    // Readable but NOT searchable on Atlas — whatever finds one of these must rewrite it.
    const raw = new Float32Array([1, 2, 3]);
    const legacy = new Binary(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
    expect(legacy.sub_type).toBe(Binary.SUBTYPE_DEFAULT);
    expect(fromBinData(legacy)).toEqual([1, 2, 3]);
  });

  it('exports header-free float32 bytes identically from either representation', () => {
    // The export format is the raw payload, so an artifact does not depend on the BSON wrapper.
    const vec = [0.5, -0.25, 0.125];
    expect(toFloat32Bytes(toBinData(vec))).toEqual(toFloat32Bytes(vec));
    expect(toFloat32Bytes(vec).length).toBe(vec.length * 4);
  });

  it('passes an array through unchanged, so both representations can coexist', () => {
    // A collection can hold both vintages mid-migration; readers must not care which they get.
    expect(fromBinData([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('narrows float64 precision to float32, which is the actual tradeoff', () => {
    // Not a lossless round-trip in general — 0.1 has no exact float32 form. The precision loss is
    // ~1e-8 relative, far below the resolution at which cosine similarity ranks precedents, and
    // it is the price of 3x less disk. Asserted rather than left implicit.
    const [back] = fromBinData(toBinData([0.1]));
    expect(back).not.toBe(0.1);
    expect(Math.abs(back - 0.1)).toBeLessThan(1e-8);
  });

  it('is 3x smaller than the BSON double array it replaces at the real dimension', () => {
    const vec = Array.from({ length: EMBED_DIM }, (_, i) => i / EMBED_DIM);
    expect(toBinData(vec).buffer.length).toBe(4098);      // 4096 payload + 2 header, vs 8192 raw
    expect(vectorByteLength(EMBED_DIM)).toBe(4098);        // doubles plus a per-element index key
    expect(fromBinData(toBinData(vec)).length).toBe(EMBED_DIM); // and type byte each
  });

  it('handles an empty vector without throwing', () => {
    expect(fromBinData(toBinData([]))).toEqual([]);
  });

  it('decodes a legacy subtype-0 BinData sitting at an unaligned byte offset', () => {
    // A Float32Array VIEW over the raw buffer requires a 4-aligned byteOffset and throws
    // otherwise. Node's allocator always returns aligned offsets, so this never fires on a buffer
    // we made — but a payload that is a subarray of a larger decoded document can land anywhere.
    // Only the subtype-0 path takes that view; subtype 9 delegates to the driver.
    const payload = toFloat32Bytes([1, 2, 3]);
    const backing = Buffer.alloc(64);
    backing.set(payload, 1);                           // deliberately offset by one byte
    const unaligned = new Binary(backing.subarray(1, 1 + payload.length));
    expect(unaligned.buffer.byteOffset % 4).not.toBe(0);
    expect(fromBinData(unaligned)).toEqual([1, 2, 3]);
  });
});
