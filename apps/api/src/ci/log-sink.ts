import type { WriteStream } from "node:fs";

/**
 * Byte-capped, backpressure-aware sink for one job's log (issue #86, Tier 0).
 *
 * Before this, the runner piped a step's stdout+stderr straight into a
 * `WriteStream` with no cap and without ever looking at `write()`'s return value.
 * A one-line step — `yes > /dev/stdout` — therefore filled the volume until the
 * job timeout expired, and on the shipped compose stack that volume also held the
 * SQLite database. Unbounded log growth was a denial of service against the whole
 * forge, available to any step.
 *
 * Two fixes, both here:
 *
 *  - **Cap.** At most `capBytes` reach disk per job, MARKER INCLUDED. The chunk
 *    that crosses the cap is written truncated, a one-line marker is appended
 *    inside the cap, and every later write is dropped. Keeping the marker inside
 *    the cap is what makes it survive the log endpoint, which serves at most
 *    `capBytes`. The job itself is NOT killed — a noisy job is not
 *    necessarily a failing one, and changing a job's conclusion because of its
 *    output volume would be a surprising new failure mode.
 *  - **Backpressure.** `write()` reports whether the stream accepted the bytes,
 *    so the caller can pause the child's pipes until `onDrain` fires instead of
 *    buffering unbounded data in the API process's heap. Once truncated the sink
 *    reports "accepted" for everything: the bytes are discarded, not queued, so
 *    there is nothing to wait for.
 */

/** Default per-job cap: 10 MiB of log is far past useful and far short of a full disk. */
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;

/** Floor for an operator override — below this a log is too small to diagnose anything. */
const MIN_MAX_LOG_BYTES = 4 * 1024;

/** Resolve the per-job log cap from `CI_MAX_LOG_BYTES` (bytes), clamped to a sane floor. */
export function maxLogBytes(): number {
  const raw = Number(process.env["CI_MAX_LOG_BYTES"]);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_LOG_BYTES;
  return Math.max(MIN_MAX_LOG_BYTES, Math.floor(raw));
}

export function truncationMarker(cap: number): string {
  return `\n[runner] --- log truncated: this job exceeded the ${cap}-byte per-job log cap (CI_MAX_LOG_BYTES); all further output was discarded ---\n`;
}

/**
 * The marker the LOG ENDPOINT appends when it has to cut a log that is already
 * bigger than the cap — a log written before the cap existed, or written by a
 * future writer that does not go through this sink. Distinct wording from
 * `truncationMarker` so a reader can tell "the runner stopped writing" apart from
 * "the server stopped sending", but both contain the same `log truncated` phrase.
 */
export function serveTruncationMarker(cap: number): string {
  return `\n[forgehub] --- log truncated: this log is larger than the ${cap}-byte serving cap (CI_MAX_LOG_BYTES); only the beginning is shown ---\n`;
}

export class LogSink {
  private written = 0;
  private truncated = false;
  /** Bytes of step output that may reach disk — the cap MINUS room for the marker. */
  private readonly contentCap: number;
  private readonly marker: string;

  constructor(
    private readonly stream: WriteStream,
    private readonly capBytes: number = maxLogBytes(),
  ) {
    // The marker is reserved OUT OF the cap, not added on top of it. If it were
    // added on top the finished file would be `cap + markerLen` bytes, and the log
    // endpoint — which serves at most `cap` bytes — would slice the marker straight
    // back off, so the one signal that says "output is missing here" would never
    // reach a single reader. Reserving it means the marker is always inside the
    // first `cap` bytes and therefore always served.
    this.marker = truncationMarker(capBytes);
    this.contentCap = Math.max(0, capBytes - Buffer.byteLength(this.marker));
  }

  /** Bytes of step output this sink will accept before truncating. */
  get contentCapacity(): number {
    return this.contentCap;
  }

  /** Total bytes handed to the stream so far (marker included). */
  get bytesWritten(): number {
    return this.written;
  }

  /** True once the cap was hit and output began being discarded. */
  get isTruncated(): boolean {
    return this.truncated;
  }

  /**
   * Append a chunk. Returns false when the underlying stream is congested and the
   * caller should pause its source until `onDrain` fires — the same contract as
   * `stream.write`. Always returns true once truncated: dropped bytes never queue.
   */
  write(chunk: string | Buffer): boolean {
    if (this.truncated) return true;

    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    const room = this.contentCap - this.written;

    if (buf.length <= room) {
      this.written += buf.length;
      return this.stream.write(buf);
    }

    // This chunk crosses the cap: keep the part that fits, then close the log out.
    if (room > 0) {
      const head = buf.subarray(0, room);
      this.written += head.length;
      this.stream.write(head);
    }
    this.markTruncated();
    return true;
  }

  /** Register a one-shot drain callback for the paused-source case. */
  onDrain(cb: () => void): void {
    this.stream.once("drain", cb);
  }

  /** Flush and close the underlying stream. */
  end(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }

  private markTruncated(): void {
    this.truncated = true;
    this.written += Buffer.byteLength(this.marker);
    this.stream.write(this.marker);
  }
}
