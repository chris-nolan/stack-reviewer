// Durable app state: review drafts/findings, agent transcripts and Home's seen/pins.
// Desktop: SQLite via Rust (`store_*` commands). Browser (?demo, ?snapshot): localStorage.
// Reads are synchronous from an in-memory cache loaded once at startup (`initDurable`);
// writes update the cache immediately and reach the backend debounced per key.
// UI preferences stay in `local` (platform.ts).

import { invoke, isTauri } from "./platform";

export type Ns = "review" | "chat" | "home" | "meta" | "guide";
export const NAMESPACES: Ns[] = ["review", "chat", "home", "meta", "guide"];

export interface Backend {
  load(namespaces: string[]): Promise<Record<string, Record<string, string>>>;
  set(ns: string, key: string, value: string): Promise<void>;
  delete(ns: string, key: string): Promise<void>;
}

/** Where legacy localStorage values live (keys without the "stack-reviewer." prefix). */
export interface LegacySource {
  entries(): Record<string, string>;
  remove(keys: string[]): void;
}

export type MigrationItem = { legacyKey: string; ns: Ns; key: string; value: string };

const HOME_NAMES = ["seen", "seenInit", "pinnedStacks", "recent", "pinnedRepos"];

/** Pure mapping of legacy localStorage entries (unprefixed key → raw JSON) to namespace/key rows. */
export function planMigration(entries: Record<string, string>): MigrationItem[] {
  const out: MigrationItem[] = [];
  for (const [legacyKey, value] of Object.entries(entries)) {
    if (legacyKey === "review") {
      let all: unknown;
      try {
        all = JSON.parse(value);
      } catch {
        continue;
      }
      if (!all || typeof all !== "object" || Array.isArray(all)) continue;
      for (const [pr, st] of Object.entries(all)) out.push({ legacyKey, ns: "review", key: pr, value: JSON.stringify(st) });
    } else if (legacyKey.startsWith("chat.")) {
      if (value === "null") out.push({ legacyKey, ns: "chat", key: "", value }); // cleared chat: just drop the key
      else out.push({ legacyKey, ns: "chat", key: legacyKey.slice("chat.".length), value });
    } else if (HOME_NAMES.some((n) => legacyKey === n || legacyKey.startsWith(`${n}:`))) {
      out.push({ legacyKey, ns: "home", key: legacyKey, value });
    }
  }
  return out.filter((i) => i.key !== "" || i.ns !== "chat");
}

/** Legacy keys that planMigration recognises, including ones it drops (cleared chats, bad JSON). */
export function legacyKeysToRemove(entries: Record<string, string>): string[] {
  return Object.keys(entries).filter(
    (k) => k === "review" || k.startsWith("chat.") || HOME_NAMES.some((n) => k === n || k.startsWith(`${n}:`)),
  );
}

const PREFIX = "stack-reviewer.";

export const browserLegacy: LegacySource = {
  entries() {
    const out: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(PREFIX)) out[k.slice(PREFIX.length)] = localStorage.getItem(k) ?? "";
      }
    } catch {
      /* storage unavailable */
    }
    return out;
  },
  remove(keys) {
    try {
      for (const k of keys) localStorage.removeItem(PREFIX + k);
    } catch {
      /* storage unavailable */
    }
  },
};

export const tauriBackend: Backend = {
  load: (namespaces) => invoke("store_load", { namespaces }),
  set: (ns, key, value) => invoke("store_set", { ns, key, value }),
  delete: (ns, key) => invoke("store_delete", { ns, key }),
};

const DB = "stack-reviewer.db.";
/** Browser preview: one localStorage entry per row, kept apart from the legacy keys. */
export const browserBackend: Backend = {
  async load(namespaces) {
    const out: Record<string, Record<string, string>> = Object.fromEntries(namespaces.map((n) => [n, {}]));
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k?.startsWith(DB)) continue;
        const rest = k.slice(DB.length);
        const dot = rest.indexOf("/");
        const ns = rest.slice(0, dot);
        if (dot > 0 && out[ns]) out[ns][rest.slice(dot + 1)] = localStorage.getItem(k) ?? "";
      }
    } catch {
      /* storage unavailable */
    }
    return out;
  },
  async set(ns, key, value) {
    try {
      localStorage.setItem(`${DB}${ns}/${key}`, value);
    } catch {
      /* storage unavailable */
    }
  },
  async delete(ns, key) {
    try {
      localStorage.removeItem(`${DB}${ns}/${key}`);
    } catch {
      /* storage unavailable */
    }
  },
};

const DEBOUNCE_MS = 400;
const id = (ns: string, key: string) => `${ns}\u0000${key}`;

export class DurableStore {
  private cache = new Map<string, Map<string, unknown>>();
  private pending = new Map<string, { ns: string; key: string; timer: ReturnType<typeof setTimeout> }>();
  private inflight = new Set<Promise<unknown>>();
  ready = false;

  constructor(private backend: Backend, private debounceMs = DEBOUNCE_MS) {}

  /** Load every namespace; on desktop, first run the one-time localStorage migration. */
  async init(legacy?: LegacySource): Promise<void> {
    const rows = await this.backend.load(NAMESPACES);
    this.fill(rows);
    if (legacy && !this.get("meta", "migrated", false)) await this.migrate(legacy);
    this.ready = true;
  }

  private fill(rows: Record<string, Record<string, string>>) {
    for (const [ns, kv] of Object.entries(rows)) {
      const m = new Map<string, unknown>();
      for (const [k, v] of Object.entries(kv)) {
        try {
          m.set(k, JSON.parse(v));
        } catch {
          /* skip corrupt row */
        }
      }
      this.cache.set(ns, m);
    }
  }

  /** Copy legacy localStorage values in, mark done, and only then delete the old keys. */
  private async migrate(legacy: LegacySource) {
    const entries = legacy.entries();
    for (const item of planMigration(entries)) {
      await this.backend.set(item.ns, item.key, item.value);
      let parsed: unknown;
      try {
        parsed = JSON.parse(item.value);
      } catch {
        continue;
      }
      if (!this.cache.has(item.ns)) this.cache.set(item.ns, new Map());
      this.cache.get(item.ns)!.set(item.key, parsed);
    }
    await this.backend.set("meta", "migrated", JSON.stringify(Date.now()));
    this.cache.get("meta")?.set("migrated", true);
    legacy.remove(legacyKeysToRemove(entries));
  }

  get<T>(ns: Ns, key: string, fallback: T): T {
    const m = this.cache.get(ns);
    return m && m.has(key) ? (m.get(key) as T) : fallback;
  }

  all<T>(ns: Ns): Record<string, T> {
    return Object.fromEntries(this.cache.get(ns) ?? []) as Record<string, T>;
  }

  set(ns: Ns, key: string, value: unknown) {
    if (!this.cache.has(ns)) this.cache.set(ns, new Map());
    this.cache.get(ns)!.set(key, value);
    this.schedule(ns, key);
  }

  delete(ns: Ns, key: string) {
    this.cache.get(ns)?.delete(key);
    this.schedule(ns, key);
  }

  private schedule(ns: string, key: string) {
    const k = id(ns, key);
    const prev = this.pending.get(k);
    if (prev) clearTimeout(prev.timer);
    this.pending.set(k, { ns, key, timer: setTimeout(() => this.write(k), this.debounceMs) });
  }

  // Serialises the cache's current value for the key, so bursts collapse into one write.
  private write(k: string) {
    const p = this.pending.get(k);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(k);
    const m = this.cache.get(p.ns);
    const op = m && m.has(p.key) ? this.backend.set(p.ns, p.key, JSON.stringify(m.get(p.key))) : this.backend.delete(p.ns, p.key);
    const tracked: Promise<unknown> = op.catch((e) => console.error("durable write failed", p.ns, p.key, e)).finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** Send every pending write now (beforeunload / tab hidden). Resolves when in-flight writes settle. */
  async flush(): Promise<void> {
    for (const k of [...this.pending.keys()]) this.write(k);
    await Promise.all([...this.inflight]);
  }
}

export const durable = new DurableStore(isTauri() ? tauriBackend : browserBackend);

let started: Promise<void> | null = null;
/** Load durable state once; call before anything reads from it. */
export function initDurable(): Promise<void> {
  if (!started) {
    started = durable.init(isTauri() ? browserLegacy : undefined).then(() => {
      if (typeof window !== "undefined") {
        window.addEventListener("beforeunload", () => void durable.flush());
        document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && void durable.flush());
      }
    });
  }
  return started;
}
