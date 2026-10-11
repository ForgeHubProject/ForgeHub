/**
 * A byte-bounded LRU of derived data, keyed by a content-addressed string (blob
 * oid + handler + build, as an ETag), so an entry is never stale. Used for
 * handler outputs — previews, conversions — that are computed on demand and
 * never stored beside the repository.
 */
export class ByteCache<V extends { bytes: Uint8Array }> {
  private entries = new Map<string, V>();
  private bytes = 0;

  constructor(private readonly budget: number) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      // Re-insert to mark it most recently used.
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: V): void {
    if (value.bytes.length > this.budget) return;
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.bytes.length;
    }
    this.entries.set(key, value);
    this.bytes += value.bytes.length;
    for (const [k, v] of this.entries) {
      if (this.bytes <= this.budget) break;
      this.entries.delete(k);
      this.bytes -= v.bytes.length;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

/** RFC 9110 If-None-Match, weak comparison (as /rawblob does). */
export function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  const strip = (v: string) => v.trim().replace(/^W\//, "");
  return raw.split(",").some((candidate) => {
    const value = strip(candidate);
    return value === "*" || value === etag;
  });
}
