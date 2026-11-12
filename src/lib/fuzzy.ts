// Small fuzzy matcher for the command palette. Pure, no dependencies.

const isBoundary = (s: string, i: number) => i === 0 || /[\s/_.\-:#]/.test(s[i - 1]) || (/[A-Z]/.test(s[i]) && /[a-z]/.test(s[i - 1]));

/** Score `query` against `text`; null when it doesn't match. Higher is better. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();

  // Substring matches beat scattered matches: prefix > word start > anywhere.
  const at = t.indexOf(q);
  if (at >= 0) {
    let best = 1000 - at;
    if (at === 0) best += 1000;
    else if (isBoundary(text, at)) best += 600;
    // Tighter when the match covers more of the text.
    return best + Math.round((q.length / t.length) * 100);
  }

  // Subsequence match, rewarding consecutive runs and word starts.
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += 10;
    if (found === prev + 1) score += 15;
    if (isBoundary(text, found)) score += 20;
    prev = found;
    ti = found + 1;
  }
  return score - Math.min(prev, 100) / 10;
}

/** Filter and rank items by query. An empty query keeps the original order. */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string | string[]): T[] {
  if (!query.trim()) return items;
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const texts = text(item);
    let best: number | null = null;
    for (const s of Array.isArray(texts) ? texts : [texts]) {
      const sc = fuzzyScore(query, s);
      if (sc != null && (best == null || sc > best)) best = sc;
    }
    if (best != null) scored.push({ item, score: best, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.item);
}
