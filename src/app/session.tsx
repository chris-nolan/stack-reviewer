import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DataSource } from "../lib/source";
import type { Viewer } from "../lib/model";
import { GitHubSource } from "../lib/github";
import { FixtureSource } from "../lib/fixtures";
import { setStoreScope } from "../lib/scope";
import { adoptLegacyRows } from "../lib/accountScope";
import {
  accountRemove, accountSave, accountSelect, accountsLoad, accountToken, ghToken, local,
  type StoredAccount, type Via,
} from "../lib/platform";
import { resetForAccountChange } from "./accountSwitch";

/** Two made-up accounts so `?demo` can show the account menu. Switching between them only changes the shown identity. */
const DEMO_ACCOUNTS: StoredAccount[] = [{ login: "you", via: "gh" }, { login: "priya-k", via: "token" }];

export type AddAccount = { via: "gh"; login: string } | { via: "device" | "token"; token: string };

type Session = {
  status: "loading" | "signed-out" | "ready";
  source: DataSource | null;
  viewer: Viewer | null;
  org: string;
  orgs: string[];
  error: string | null;
  /** Every account this app knows, and which one is in use. */
  accounts: StoredAccount[];
  current: string | null;
  setOrg: (org: string) => void;
  switchAccount: (login: string) => Promise<void>;
  /** Signs in (verifying the token) and makes the account current. gh accounts are read from gh, nothing is copied. */
  addAccount: (a: AddAccount) => Promise<void>;
  /** Forgets the account in this app only; gh and GitHub are untouched. */
  removeAccount: (login: string) => Promise<void>;
  useDemo: () => Promise<void>;
  /** Removes the current account. */
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
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const demo = useRef(false);

  const activate = useCallback(async (src: DataSource) => {
    const v = await src.viewer();
    const list = await src.orgs();
    setStoreScope(`${src.label ?? src.kind}:${v.login}`, v.login);
    if (src.kind === "github") adoptLegacyRows(v.login);
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

  const applyIndex = useCallback((i: { accounts: StoredAccount[]; current: string | null }) => {
    setAccounts(i.accounts);
    setCurrent(i.current);
  }, []);

  /** A source for a stored account. gh accounts get a fresh token from gh every time. */
  const sourceFor = useCallback(async (login: string) => {
    const token = await accountToken(login);
    if (!token) throw new Error(`No saved sign-in for ${login}. Add the account again.`);
    return new GitHubSource(token);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    (async () => {
      try {
        if (params.has("demo")) {
          demo.current = true;
          setAccounts(DEMO_ACCOUNTS);
          setCurrent(DEMO_ACCOUNTS[0].login);
          return await activate(new FixtureSource(DEMO_ACCOUNTS[0].login));
        }
        if (import.meta.env.DEV && params.has("snapshot")) {
          const { SnapshotSource } = await import("../lib/snapshot");
          return await activate(await SnapshotSource.load());
        }
        const index = await accountsLoad();
        applyIndex(index);
        const login = index.current ?? index.accounts[0]?.login;
        if (login) {
          try {
            return await activate(await sourceFor(login));
          } catch (e) {
            // e.g. gh logged this account out: keep the account listed so the user can pick another or re-add it.
            setError(e instanceof Error ? e.message : String(e));
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setStatus("signed-out");
    })();
  }, [activate, applyIndex, sourceFor]);

  const goSignedOut = useCallback(async () => {
    await resetForAccountChange(qc);
    setStoreScope("", "");
    setSource(null);
    setViewer(null);
    setStatus("signed-out");
  }, [qc]);

  const switchAccount = useCallback(
    async (login: string) => {
      if (login === current && status === "ready") return;
      if (demo.current) {
        await resetForAccountChange(qc);
        setCurrent(login);
        return activate(new FixtureSource(login));
      }
      const src = await sourceFor(login);
      await src.viewer(); // throws before anything changes if the token no longer works
      await resetForAccountChange(qc);
      await activate(src);
      applyIndex(await accountSelect(login));
    },
    [current, status, qc, activate, sourceFor, applyIndex],
  );

  const removeAccount = useCallback(async (login: string) => {
    if (demo.current) {
      const rest = accounts.filter((a) => a.login !== login);
      setAccounts(rest);
      if (login === current) {
        if (rest[0]) await switchAccount(rest[0].login);
        else await goSignedOut();
      }
      return;
    }
    const index = await accountRemove(login);
    applyIndex(index);
    if (login !== current) return;
    const next = index.current;
    if (next) {
      try {
        const src = await sourceFor(next);
        await src.viewer();
        await resetForAccountChange(qc);
        return await activate(src);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    await goSignedOut();
  }, [accounts, current, switchAccount, goSignedOut, qc, activate, applyIndex, sourceFor]);

  const value = useMemo<Session>(
    () => ({
      status, source, viewer, org, orgs, error, accounts, current,
      setOrg: (o) => {
        setOrgState(o);
        local.set("org", o);
      },
      switchAccount,
      addAccount: async (a) => {
        const token = a.via === "gh" ? await ghToken(a.login) : a.token.trim();
        const src = new GitHubSource(token);
        const v = await src.viewer(); // throws if the token is bad
        applyIndex(await accountSave(v.login, a.via as Via, a.via === "gh" ? undefined : token));
        await resetForAccountChange(qc);
        await activate(src);
      },
      removeAccount,
      useDemo: async () => {
        demo.current = true;
        setAccounts(DEMO_ACCOUNTS);
        setCurrent(DEMO_ACCOUNTS[0].login);
        await resetForAccountChange(qc);
        await activate(new FixtureSource(DEMO_ACCOUNTS[0].login));
      },
      signOut: async () => {
        if (current) await removeAccount(current);
      },
    }),
    [status, source, viewer, org, orgs, error, accounts, current, activate, applyIndex, sourceFor, switchAccount, removeAccount, qc],
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
