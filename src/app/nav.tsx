import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { RepoRef } from "../lib/model";
import { local } from "../lib/platform";

export type HomeSection = "review" | "mine" | "repo" | "recent";

export type Route =
  | { name: "home"; section?: HomeSection; repo?: RepoRef }
  | { name: "overview"; repo: RepoRef; stackKey: string }
  | { name: "review"; repo: RepoRef; stackKey: string; layer: number; file?: string; line?: number };

type Nav = {
  route: Route;
  /** Open a screen. Moving within the same screen (home sections, layers of one stack) replaces the current entry. */
  go: (r: Route) => void;
  /** Return to a parent screen (Inbox, a stack's Overview), reusing its earlier entry if there is one. */
  up: (r: Route) => void;
  back: () => void;
  canGoBack: boolean;
};

const sameStack = (a: Route, b: Route) =>
  "stackKey" in a && "stackKey" in b && a.stackKey === b.stackKey && a.repo.owner === b.repo.owner && a.repo.repo === b.repo.repo;

/** Same kind of screen for the same thing: navigating between them shouldn't add history. */
const sameScreen = (a: Route, b: Route) => a.name === b.name && (a.name === "home" || sameStack(a, b));

const MAX = 30;

export function pushRoute(history: Route[], r: Route): Route[] {
  const cur = history[history.length - 1];
  if (cur && sameScreen(cur, r)) return [...history.slice(0, -1), r];
  return [...history, r].slice(-MAX);
}

export function upRoute(history: Route[], r: Route): Route[] {
  for (let i = history.length - 1; i >= 0; i--) {
    if (sameScreen(history[i], r)) {
      // Keep the earlier entry (e.g. the inbox section you were on) when going up to home.
      return [...history.slice(0, i), r.name === "home" ? history[i] : r];
    }
  }
  return r.name === "home" ? [r] : pushRoute(history, r);
}

const Ctx = createContext<Nav | null>(null);

export type RecentStack = { repo: RepoRef; stackKey: string; title: string; layer: number; at: string };

export function rememberRecent(entry: RecentStack) {
  const list = local.get<RecentStack[]>("recent", []).filter(
    (r) => !(r.repo.owner === entry.repo.owner && r.repo.repo === entry.repo.repo && r.stackKey === entry.stackKey),
  );
  local.set("recent", [entry, ...list].slice(0, 20));
}

export function NavProvider({ children }: { children: ReactNode }) {
  const [history, setHistory] = useState<Route[]>([{ name: "home", section: "review" }]);
  const go = useCallback((r: Route) => setHistory((h) => pushRoute(h, r)), []);
  const up = useCallback((r: Route) => setHistory((h) => upRoute(h, r)), []);
  const back = useCallback(() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h)), []);
  const value = useMemo(
    () => ({ route: history[history.length - 1], go, up, back, canGoBack: history.length > 1 }),
    [history, go, up, back],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNav(): Nav {
  const n = useContext(Ctx);
  if (!n) throw new Error("useNav outside NavProvider");
  return n;
}
