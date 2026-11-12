// Pulls the useful part out of a GitHub Actions job log.

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/;
const ERRORISH = /(##\[error\]|\bFAIL(ED)?\b|\bError\b|\berror(\[|:)|\bpanicked\b|✕|✗|Traceback|AssertionError|exit code [1-9])/;

export function cleanLog(raw: string): string[] {
  return raw.split(/\r?\n/).map((l) => l.replace(TS, "").replace(/\x1b\[[0-9;]*m/g, ""));
}

/** Returns the region around the first and last error-looking lines (or the tail). */
export function failureExcerpt(raw: string, max = 120): { lines: string[]; truncated: boolean } {
  const lines = cleanLog(raw).filter((l) => !/^##\[(group|endgroup)\]/.test(l));
  const hits = lines.map((l, i) => (ERRORISH.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!hits.length) {
    const tail = lines.slice(-60);
    return { lines: tail, truncated: lines.length > tail.length };
  }
  const start = Math.max(0, hits[0] - 15);
  const end = Math.min(lines.length, hits[hits.length - 1] + 6);
  const slice = lines.slice(start, end);
  if (slice.length <= max) return { lines: slice, truncated: start > 0 || end < lines.length };
  return { lines: [...slice.slice(0, max / 2), "…", ...slice.slice(-max / 2)], truncated: true };
}
