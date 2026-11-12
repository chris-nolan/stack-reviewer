// Turns PR descriptions into readable plain text for summaries. Strips the boilerplate that
// stacking tools (gh stack, Graphite, ghstack, spr) prepend and the markdown syntax.

const STACK_BOILERPLATE = [
  /^\s*part \d+ of \d+\b.*$/i,
  /^\s*(this pr|this change) is (part of|the (bottom|top) of) (a |the )?stack.*$/i,
  /^\s*stack(ed)? (on|pr|prs|created with).*$/i,
  /^\s*[-*]\s+(→|👉|⬅|➡)?\s*#\d+.*$/, // stack lists like "- #123 ⬅"
  /^\s*current dependencies on\/for this pr:?\s*$/i,
  /graphite\.dev|app\.graphite\.com|ghstack-source-id|pull request resolved:/i,
];

export function plainText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/\r/g, "");
}

/** Removes stacking-tool boilerplate lines and sentences. */
export function stripStackBoilerplate(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      // "Part 1 of 5 in [stack #12](…), which replaces #9. This PR is the bottom…" → keep later sentences
      const m = /^\s*part \d+ of \d+\b[^.]*\.\s*(.*)$/i.exec(line);
      if (m) return m[1].replace(/^this pr is (the (bottom|top) of the stack|based on #\d+)[^.]*\.\s*/i, "");
      return STACK_BOILERPLATE.some((re) => re.test(line)) ? "" : line;
    })
    .join("\n");
}

/** First meaningful paragraph of a PR description, as plain text. */
export function summarize(md: string, max = 320): string {
  // Headings are section labels, not content: turn them into paragraph breaks.
  const text = stripStackBoilerplate(plainText(md.replace(/^[ \t]{0,3}#{1,6}[ \t].*$/gm, "\n")));
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/^[ \t]*[-*+][ \t]+/gm, "").replace(/\s*\n\s*/g, " ").trim()).filter((p) => p.length > 0);
  const first = paras.find((p) => !/^(summary|what this changes|why|changes|context|description|motivation)[:.]?$/i.test(p) && p.length > 12) ?? paras[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** Splits "feat(cg): add thing" into a type tag and a title. */
export function splitConventional(title: string): { tag: string | null; text: string } {
  const m = /^(\w+)(\([^)]*\))?!?:\s*(.+)$/.exec(title);
  return m ? { tag: m[1] + (m[2] ?? ""), text: m[3] } : { tag: null, text: title };
}
