import type { ReactNode } from "react";

/** Inline markdown for guide text (**bold**, `code`) with #123 turned into links to that layer. */
export function InlineText({ text, layers, onLayer }: { text: string; layers: Map<number, number>; onLayer: (index: number) => void }) {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|#(\d+)/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(<strong key={k++} style={{ color: "var(--text)", fontWeight: 600 }}>{m[1]}</strong>);
    else if (m[2] != null) out.push(<code key={k++}>{m[2]}</code>);
    else {
      const idx = layers.get(Number(m[3]));
      out.push(idx ? <a key={k++} href="#layer" onClick={(e) => { e.preventDefault(); onLayer(idx); }}>#{m[3]}</a> : `#${m[3]}`);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
