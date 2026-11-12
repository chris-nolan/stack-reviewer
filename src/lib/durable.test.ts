import { describe, expect, it, vi } from "vitest";
import { DurableStore, planMigration, legacyKeysToRemove, type Backend, type LegacySource } from "./durable";

function fakeBackend(seed: Record<string, Record<string, string>> = {}) {
  const db: Record<string, Record<string, string>> = structuredClone(seed);
  const log: string[] = [];
  const b: Backend = {
    load: async (ns) => Object.fromEntries(ns.map((n) => [n, { ...(db[n] ?? {}) }])),
    set: async (ns, k, v) => {
      (db[ns] ??= {})[k] = v;
      log.push(`set ${ns}/${k}`);
    },
    delete: async (ns, k) => {
      delete db[ns]?.[k];
      log.push(`del ${ns}/${k}`);
    },
  };
  return { b, db, log };
}

function fakeLegacy(entries: Record<string, string>) {
  const data = { ...entries };
  const removed: string[] = [];
  const src: LegacySource = {
    entries: () => ({ ...data }),
    remove: (keys) => keys.forEach((k) => (removed.push(k), delete data[k])),
  };
  return { src, data, removed };
}

const LEGACY = {
  review: JSON.stringify({ "o/r#1": { drafts: [], findings: [] }, "o/r#2": { drafts: [], findings: [], summary: "s" } }),
  "chat.stack1|claude": JSON.stringify({ items: [], sessionId: "x" }),
  "chat.stack2|claude": "null",
  "seen:demo:alice": "{}",
  seenInit: "true",
  "pinnedStacks:github:bob": "[]",
  "recent:demo:alice": "[]",
  "pinnedRepos:demo:alice": "[]",
  layout: '"split"',
  org: '"acme"',
  "agentPrefs.claude": "{}",
};

describe("planMigration", () => {
  it("maps durable keys and skips UI prefs", () => {
    const plan = planMigration(LEGACY);
    const rows = plan.map((p) => `${p.ns}/${p.key}`).sort();
    expect(rows).toEqual([
      "chat/stack1|claude",
      "home/pinnedRepos:demo:alice",
      "home/pinnedStacks:github:bob",
      "home/recent:demo:alice",
      "home/seen:demo:alice",
      "home/seenInit",
      "review/o/r#1",
      "review/o/r#2",
    ]);
    expect(JSON.parse(plan.find((p) => p.key === "o/r#2")!.value).summary).toBe("s");
  });
  it("removes only migrated keys, including cleared chats", () => {
    expect(legacyKeysToRemove(LEGACY).sort()).toEqual(
      ["chat.stack1|claude", "chat.stack2|claude", "pinnedRepos:demo:alice", "pinnedStacks:github:bob", "recent:demo:alice", "review", "seen:demo:alice", "seenInit"].sort(),
    );
  });
  it("ignores corrupt review JSON", () => {
    expect(planMigration({ review: "{nope" })).toEqual([]);
  });
});

describe("DurableStore", () => {
  it("migrates once: writes rows, marks done, then removes legacy keys", async () => {
    const { b, db, log } = fakeBackend();
    const { src, data, removed } = fakeLegacy(LEGACY);
    const s = new DurableStore(b, 0);
    await s.init(src);
    expect(db.review["o/r#1"]).toBeDefined();
    expect(db.meta.migrated).toBeDefined();
    expect(log.indexOf("set meta/migrated")).toBeGreaterThan(log.indexOf("set review/o/r#1"));
    expect(removed).toContain("review");
    expect(data.layout).toBe('"split"');
    expect(data.org).toBe('"acme"');
    expect(s.get("home", "seenInit", false)).toBe(true);
    expect(Object.keys(s.all("review"))).toHaveLength(2);

    // second run: marked migrated, legacy untouched
    const again = fakeLegacy({ review: LEGACY.review });
    await new DurableStore(b, 0).init(again.src);
    expect(again.removed).toEqual([]);
  });

  it("keeps legacy keys if the backend fails mid-migration", async () => {
    const { b } = fakeBackend();
    b.set = vi.fn().mockRejectedValue(new Error("disk"));
    const { src, removed } = fakeLegacy(LEGACY);
    await expect(new DurableStore(b, 0).init(src)).rejects.toThrow();
    expect(removed).toEqual([]);
  });

  it("debounces writes per key, deletes, and flushes", async () => {
    vi.useFakeTimers();
    const { b, db, log } = fakeBackend({ chat: { a: '"old"' } });
    const s = new DurableStore(b, 100);
    await s.init();
    s.set("chat", "a", "v1");
    s.set("chat", "a", "v2");
    s.set("review", "k", { n: 1 });
    expect(log).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(log.filter((l) => l === "set chat/a")).toHaveLength(1);
    expect(db.chat.a).toBe('"v2"');
    s.delete("chat", "a");
    expect(s.get("chat", "a", null)).toBeNull();
    await s.flush();
    expect(db.chat.a).toBeUndefined();
    vi.useRealTimers();
  });
});
