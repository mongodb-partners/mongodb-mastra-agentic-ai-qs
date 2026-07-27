import { Binary } from 'mongodb';

/**
 * Embeddings as float32 BSON Vector BinData rather than a BSON array of doubles.
 *
 * A BSON `number[]` pays 8 bytes per element PLUS a stringified index key and a type byte per
 * entry: 13,814 B/document at 1024 dims, 9.65 GB per million. float32 vector BinData is
 * 4,605 B/document, 3.22 GB per million — and Atlas `$vectorSearch` reads it natively, so nothing
 * downstream changes.
 *
 * ⚠️ IT MUST BE BINARY SUBTYPE 9 (`SUBTYPE_VECTOR`), NOT SUBTYPE 0. Measured on Atlas M30
 * (2026-07-27): 1,000 documents whose `embedding` was a subtype-0 Binary of the same 4,096 float32
 * bytes, against a READY, queryable 1024-dim cosine `vectorSearch` index — `$vectorSearch` returned
 * **zero hits, and no error**. Atlas indexes the vector subtype and silently ignores generic
 * binary. That is exactly the failure this repo keeps hitting in other guises: retrieval that
 * returns nothing while every status field reads healthy. `Binary.fromFloat32Array` sets subtype 9
 * and prepends the 2-byte dtype header (0x27 float32, 0x00 padding) Atlas reads to know the
 * element type — which is why a 1024-dim vector is 4,098 bytes on the wire, not 4,096.
 *
 * float32 over int8 because it loses no meaningful precision at the source (~1e-8 relative, far
 * below the resolution at which cosine similarity ranks precedents). int8 stays available if disk
 * ever becomes the binding constraint, at a real recall cost.
 */
export function toBinData(vec: number[]): Binary {
  return Binary.fromFloat32Array(new Float32Array(vec));
}

/** Bytes a `toBinData` result occupies for `dims` elements: the float32 payload plus the 2-byte
 *  dtype header that makes it a BSON vector rather than an opaque blob. */
export function vectorByteLength(dims: number): number {
  return dims * 4 + 2;
}

/**
 * Decode either representation, so a mixed-vintage collection still reads cleanly — a corpus
 * part-way through a migration holds both, and readers must not have to care which they get.
 */
export function fromBinData(v: Binary | number[]): number[] {
  if (Array.isArray(v)) return v;
  // Subtype 9 knows its own dtype and header length, so let the driver strip them.
  if (v.sub_type === Binary.SUBTYPE_VECTOR) return Array.from(v.toFloat32Array());
  // Legacy subtype-0 payloads: raw float32 bytes with no header. Still decodable, so a corpus
  // written before the subtype fix reads back rather than erroring — but it is NOT searchable on
  // Atlas, so anything that finds one should rewrite it, not just read it.
  const b = v.buffer;
  // Slice rather than view. `new Float32Array(b.buffer, b.byteOffset, …)` requires byteOffset to
  // be a multiple of 4 and throws "start offset of Float32Array should be a multiple of 4"
  // otherwise. Node's own allocator always hands back 4-aligned offsets, so this never fires on a
  // Buffer we created — but a BinData whose payload is a `subarray` of a larger decoded buffer
  // can sit at any offset (verified: offset 9 throws). The copy is 4 KB and `Array.from` copies
  // regardless, so the view buys nothing.
  return Array.from(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

/** The raw little-endian float32 payload, header stripped — the portable form for export. */
export function toFloat32Bytes(v: Binary | number[]): Buffer {
  const f32 = new Float32Array(fromBinData(v));
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
