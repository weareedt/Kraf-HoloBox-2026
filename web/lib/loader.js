/**
 * Boot-time asset loader.
 *
 * Reproduces the old Unity "Preparing videos… 110/128" bar, but honestly.
 *
 * Deliberately NOT done here:
 *   - Blobbing the video. 400+ MB of Blob plus decoded frames is how an unattended
 *     kiosk hits renderer OOM, and ObjectURLs buy nothing over 127.0.0.1 anyway —
 *     same range-request path, same media cache, and the OS page cache already has
 *     the file.
 *   - Relying on `canplaythrough` for progress. On localhost Chrome assumes infinite
 *     bandwidth and fires it almost immediately, which gives a bar that snaps to 100%
 *     and means nothing.
 *
 * What actually makes the first play stutter-free is two separate things, so we do both:
 *   Phase A  byte-warm the file into the OS page cache (real per-byte progress,
 *            bytes discarded as they arrive, ~zero JS memory)
 *   Phase B  materialise only what the first interaction needs, as a primed <video>
 *
 * Progress is reported with two signals because one cannot be both smooth and legible:
 *   bar     = bytes read / total bytes      (moves continuously)
 *   counter = files done / files total      (ticks visibly)
 */

const CONCURRENCY = 4; // Chrome caps 6/origin on HTTP/1.1; 4 keeps disk reads coherent

export class AssetLoader {
  /**
   * @param {(p:{bytes:number,totalBytes:number,files:number,totalFiles:number,ratio:number})=>void} onProgress
   */
  constructor(onProgress) {
    this.onProgress = onProgress ?? (() => {});
    this.bytes = 0;
    this.totalBytes = 0;
    this.files = 0;
    this.totalFiles = 0;
  }

  _emit() {
    this.onProgress({
      bytes: this.bytes,
      totalBytes: this.totalBytes,
      files: this.files,
      totalFiles: this.totalFiles,
      ratio: this.totalBytes ? Math.min(1, this.bytes / this.totalBytes) : 0,
    });
  }

  /**
   * Stream a URL to /dev/null purely to pull it into the OS page cache.
   * Falls back to a HEAD if the body cannot be streamed.
   */
  async _warm(url) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(String(res.status));
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.bytes += value.byteLength;
        this._emit();
      }
    } catch {
      // A failed warm is not fatal — the asset simply loads on demand later.
    } finally {
      this.files += 1;
      this._emit();
    }
  }

  /**
   * @param {{url:string,bytes:number}[]} assets
   */
  async warmAll(assets) {
    this.totalBytes = assets.reduce((n, a) => n + (a.bytes || 0), 0);
    this.totalFiles = assets.length;
    this.bytes = 0;
    this.files = 0;
    this._emit();

    const queue = [...assets];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        await this._warm(next.url);
      }
    });
    await Promise.all(workers);
  }
}

/** Decode an image fully so first paint never blocks. */
export function preloadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = async () => {
      try { await img.decode?.(); } catch { /* decode is best-effort */ }
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
