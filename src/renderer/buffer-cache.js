'use strict';

// Decoded AudioBuffers kept for instant re-audition, least recently used
// first out, bounded by bytes rather than count: a dozen long orchestral
// files would otherwise be gigabytes. Web Audio holds float32 per sample per
// channel. A buffer bigger than the whole budget plays but isn't kept; the
// pinned one (what's playing) is never evicted.
class BufferCache {
  constructor(budget) {
    this.budget = budget;
    this.map = new Map(); // id -> buffer (insertion order = LRU)
    this.bytes = 0;
    this.pinned = null;
  }

  static sizeOf(buf) {
    return buf.length * buf.numberOfChannels * 4;
  }

  get(id) {
    const buf = this.map.get(id);
    if (buf) {
      this.map.delete(id);
      this.map.set(id, buf);
    }
    return buf;
  }

  has(id) {
    return this.map.has(id);
  }

  // False if it's too big to keep.
  set(id, buf) {
    this.delete(id);
    const size = BufferCache.sizeOf(buf);
    if (size > this.budget) return false;
    this.map.set(id, buf);
    this.bytes += size;
    this.evict();
    return true;
  }

  delete(id) {
    const buf = this.map.get(id);
    if (!buf) return;
    this.map.delete(id);
    this.bytes -= BufferCache.sizeOf(buf);
  }

  pin(id) {
    this.pinned = id;
    this.evict();
  }

  evict() {
    for (const id of [...this.map.keys()]) {
      if (this.bytes <= this.budget) break;
      if (id !== this.pinned) this.delete(id);
    }
  }
}

// The received bytes as an ArrayBuffer for decodeAudioData, which detaches
// it. IPC normally hands us a view over a buffer of exactly its size — use
// that buffer as-is; only copy when the view is part of something larger.
function ownBuffer(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// load(id, stale) → AudioBuffer, or null if the caller moved on. A load
// nobody wants any more stops at the next step — before asking main for the
// bytes, before decoding, before caching — so arrowing past a sample costs
// next to nothing. Two callers of one sample (a play and a prefetch) share a
// load; the later caller's `stale` then decides. read(id) resolves to bytes,
// or null when main dropped the request for a newer one; decode(ab) decodes.
function createLoader(cache, read, decode) {
  const loading = new Map(); // id -> { stale, promise }
  return function load(id, stale) {
    const hit = cache.get(id);
    if (hit) return Promise.resolve(hit);
    const shared = loading.get(id);
    if (shared) {
      shared.stale = stale;
      return shared.promise;
    }
    const job = { stale };
    job.promise = (async () => {
      try {
        if (job.stale()) return null;
        const bytes = await read(id);
        if (!bytes || job.stale()) return null;
        const buf = await decode(ownBuffer(bytes));
        if (job.stale()) return null;
        cache.set(id, buf);
        return buf;
      } finally {
        loading.delete(id);
      }
    })();
    loading.set(id, job);
    return job.promise;
  };
}

if (typeof module !== 'undefined') module.exports = { BufferCache, ownBuffer, createLoader };
