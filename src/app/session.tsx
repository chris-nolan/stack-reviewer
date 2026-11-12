import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DataSource } from "../lib/source";
import type { Viewer } from "../lib/model";
import { GitHubSource } from "../lib/github";
import { FixtureSource } from "../lib/fixtures";
import { setStoreScope } from "../lib/scope";
import { clearToken, getToken, local, saveToken } from "../lib/platform";

type Session = {
  status: "loading" | "signed-out" | "ready";
  source: DataSource | null;
  viewer: Viewer | null;
  org: string;
  orgs: string[];
  error: string | null;
  setOrg: (org: string) => void;
  signInWithToken: (token: string, persist?: boolean) => Promise<void>;
  useDemo: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Session["status"]>("loading");
  const [source, setSource] = useState<DataSource | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [orgs, setOrgs] = useState<string[]>([]);
  const [org, setOrgState] = useState<string>(() => local.get("org", ""));
  const [error, setError] = useState<string | null>(null);

  const activate = useCallback(async (src: DataSource) => {
    const v = await src.viewer();
    const list = await src.orgs();
    setStoreScope(`${src.label ?? src.kind}:${v.login}`);
    setSource(src);
    setViewer(v);
    setOrgs(list);
    setOrgState((cur) => {
      if (src.kind === "fixtures") return list[0];
      return cur && list.includes(cur) ? cur : (list[0] ?? v.login);
    });
    setError(null);
    setStatus("ready");
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const demo = params.has("demo");
    (async () => {
      try {
        if (demo) return await activate(new FixtureSource());
        if (import.meta.env.DEV && params.has("snapshot")) {
          const { SnapshotSource } = await import("../lib/snapshot");
          return await activate(await SnapshotSource.load());
        }
        const token = await getToken();
        if (token) return await activate(new GitHubSource(token));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setStatus("signed-out");
    })();
  }, [activate]);

  const value = useMemo<Session>(
    () => ({
      status, source, viewer, org, orgs, error,
      setOrg: (o) => {
        setOrgState(o);
        local.set("org", o);
      },
      signInWithToken: async (token, persist = true) => {
        const src = new GitHubSource(token.trim());
        await src.viewer(); // throws if the token is bad
        if (persist) await saveToken(token);
        qc.clear();
        await activate(src);
      },
      useDemo: async () => {
        qc.clear();
        await activate(new FixtureSource());
      },
      signOut: async () => {
        await clearToken();
        qc.clear();
        setSource(null);
        setViewer(null);
        setStatus("signed-out");
      },
    }),
    [status, source, viewer, org, orgs, error, activate, qc],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

/** The data source, for components that only render once signed in. */
export function useSource(): DataSource {
  const { source } = useSession();
  if (!source) throw new Error("Not signed in");
  return source;
}
