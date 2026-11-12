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
  go: (r: Route) => void;
  back: () => void;
  canGoBack: boolean;
};

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
  const go = useCallback((r: Route) => setHistory((h) => [...h.slice(-30), r]), []);
  const back = useCallback(() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h)), []);
  const value = useMemo(
    () => ({ route: history[history.length - 1], go, back, canGoBack: history.length > 1 }),
    [history, go, back],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNav(): Nav {
  const n = useContext(Ctx);
  if (!n) throw new Error("useNav outside NavProvider");
  return n;
}
