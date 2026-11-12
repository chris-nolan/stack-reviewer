import { useEffect, useMemo, useRef, useState } from "react";
import { GROUP_ORDER, PALETTE_SHORTCUT, useCollectCommands, useCommands, usePalette, type Command } from "./commands";
import { useInbox } from "./queries";
import { useNav, type RecentStack } from "./nav";
import { fuzzyFilter } from "../lib/fuzzy";
import { pinId, usePinnedStacks } from "../lib/homeStore";
import { repoKey, type RepoRef } from "../lib/model";
import { scoped } from "../lib/scope";
import { stackId } from "../lib/sinceLast";

const MAX_RESULTS = 60;

/** App-wide commands: navigation and every stack we know about (inbox, recent, pinned). */
function useGlobalCommands() {
  const { go, up } = useNav();
  const inbox = useInbox(false);
  const pinned = usePinnedStacks();
  const open = usePalette().open;
  // Recent lives in plain local state; re-read whenever the palette opens.
  const recent = useMemo(() => (open ? scoped.get<RecentStack[]>("recent", []) : []), [open]);

  const stacks = new Map<string, { repo: RepoRef; stackKey: string; title: string; tag: string }>();
  for (const p of pinned) stacks.set(pinId(p), { repo: p.repo, stackKey: p.stackKey, title: p.title, tag: "pinned" });
  for (const s of [...(inbox.data?.needsReview ?? []), ...(inbox.data?.mine ?? [])]) {
    const id = stackId(s);
    stacks.set(id, { repo: s.repo, stackKey: s.key, title: s.title, tag: stacks.get(id)?.tag ?? "inbox" });
  }
  for (const r of recent) if (!stacks.has(pinId(r))) stacks.set(pinId(r), { repo: r.repo, stackKey: r.stackKey, title: r.title, tag: "recent" });

  const commands: Command[] = [
    { id: "go-inbox", group: "Go to", title: "Go to inbox", keywords: "home stacks", run: () => up({ name: "home" }) },
    { id: "go-settings", group: "Go to", title: "Open settings", keywords: "preferences agents", run: () => go({ name: "settings" }) },
    ...[...stacks.entries()].map(([id, s]): Command => ({
      id: `stack:${id}`,
      group: "Stacks",
      title: s.title,
      hint: `${repoKey(s.repo)} · ${s.tag}`,
      keywords: repoKey(s.repo),
      run: () => go({ name: "overview", repo: s.repo, stackKey: s.stackKey }),
    })),
  ];
  useCommands(commands);
}

export function Palette() {
  useGlobalCommands();
  const { open, toggle, closePalette } = usePalette();
  const collect = useCollectCommands();

  // ⌘K / Ctrl+K from anywhere, including text fields.
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  return open ? <PaletteDialog collect={collect} onClose={closePalette} /> : null;
}

function PaletteDialog({ collect, onClose }: { collect: () => Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const all = useMemo(() => collect(), [collect]);

  const results = useMemo(() => {
    if (query.trim()) {
      return fuzzyFilter(all, query, (c) => [c.title, `${c.title} ${c.hint ?? ""} ${c.keywords ?? ""}`]).slice(0, MAX_RESULTS);
    }
    return GROUP_ORDER.flatMap((g) => all.filter((c) => c.group === g)).slice(0, MAX_RESULTS);
  }, [all, query]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    // Capture phase + stopImmediatePropagation: Escape closes only the palette, never a dialog underneath.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("keydown", esc, true);
      prev?.focus?.();
    };
  }, [onClose]);
  useEffect(() => {
    listRef.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [sel, results]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, results.length - 1));
    else if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
    else if (e.key === "Enter") run(results[sel]);
    else return;
    e.preventDefault();
  };

  const showGroups = !query.trim();
  return (
    <div onMouseDown={onClose} style={{ position: "fixed", inset: 0, background: "rgba(5,6,8,.55)", display: "grid", placeItems: "start center", paddingTop: "12vh", zIndex: 60 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{ width: "min(600px, calc(100% - 32px))", borderRadius: 14, border: "1px solid var(--border-strong)", background: "var(--surface-3)", boxShadow: "0 24px 70px rgba(0,0,0,.6)", overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        <input
          ref={inputRef}
          className="input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[sel] ? `pal-${sel}` : undefined}
          aria-label="Search commands, stacks, layers and files"
          placeholder="Search stacks, layers, files and actions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ border: 0, borderBottom: "1px solid var(--border)", borderRadius: 0, padding: "14px 16px", fontSize: 15, background: "transparent" }}
        />
        <div ref={listRef} id="palette-list" role="listbox" className="scroll" style={{ maxHeight: "50vh", overflowY: "auto", padding: 6 }}>
          {results.length === 0 && <div className="muted" style={{ padding: "14px 12px" }}>No matches.</div>}
          {results.map((c, i) => (
            <div key={c.id}>
              {showGroups && (i === 0 || results[i - 1].group !== c.group) && (
                <div className="label" style={{ padding: "8px 10px 4px" }}>{c.group}</div>
              )}
              <div
                id={`pal-${i}`}
                role="option"
                aria-selected={i === sel}
                onMouseMove={() => i !== sel && setSel(i)}
                onClick={() => run(c)}
                style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "7px 10px", borderRadius: 8, cursor: "pointer", background: i === sel ? "var(--accent-soft-bg)" : "transparent" }}
              >
                {!showGroups && <span className="faint" style={{ fontSize: 11, flex: "0 0 auto", width: 48 }}>{c.group}</span>}
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: c.current ? 600 : 400 }}>{c.title}{c.current && <span className="faint"> · current</span>}</span>
                {c.hint && <span className="faint" style={{ fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.hint}</span>}
                <span style={{ flex: "1 1 auto" }} />
                {c.shortcut && <span className="kbd">{c.shortcut}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="muted" style={{ display: "flex", gap: 14, padding: "8px 14px", borderTop: "1px solid var(--border)", fontSize: 12 }}>
          <span><span className="kbd">↑</span> <span className="kbd">↓</span> move</span>
          <span><span className="kbd">↵</span> run</span>
          <span><span className="kbd">esc</span> close</span>
        </div>
      </div>
    </div>
  );
}

/** Button that opens the palette, with its shortcut. */
export function PaletteButton({ style }: { style?: React.CSSProperties }) {
  const { openPalette } = usePalette();
  return (
    <button className="btn btn-sm" onClick={openPalette} title="Search stacks, layers, files and actions" style={style}>
      Jump to… <span className="kbd">{PALETTE_SHORTCUT}</span>
    </button>
  );
}
