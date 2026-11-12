// Per data-source/viewer local state for Home: last-seen stack snapshots and pinned stacks.
import { useSyncExternalStore } from "react";
import type { RepoRef } from "./model";
import { repoKey } from "./model";
import { scoped, storeScope } from "./scope";
import type { SeenMap, StackSeen } from "./sinceLast";

export type PinnedStack = { repo: RepoRef; stackKey: string; title: string };
export const pinId = (p: { repo: RepoRef; stackKey: string }) => `${repoKey(p.repo)}#${p.stackKey}`;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

// Cached per scope so useSyncExternalStore sees stable references.
const cache = new Map<string, unknown>();
function read<T>(key: string, fallback: T): T {
  const ck = `${storeScope()}|${key}`;
  if (!cache.has(ck)) cache.set(ck, scoped.get<T>(key, fallback));
  return cache.get(ck) as T;
}
function write<T>(key: string, value: T) {
  cache.set(`${storeScope()}|${key}`, value);
  scoped.set(key, value);
  emit();
}

const NO_SEEN: SeenMap = {};
const NO_PINS: PinnedStack[] = [];

export const seenStore = {
  get: (): SeenMap => read("seen", NO_SEEN),
  record(id: string, s: StackSeen) {
    write("seen", { ...read("seen", NO_SEEN), [id]: s });
  },
  replace(map: SeenMap) {
    write("seen", map);
  },
  initialised: () => read("seenInit", false),
  setInitialised: () => write("seenInit", true),
};

export const pinStore = {
  get: (): PinnedStack[] => read("pinnedStacks", NO_PINS),
  toggle(p: PinnedStack) {
    const cur = read("pinnedStacks", NO_PINS);
    write("pinnedStacks", cur.some((x) => pinId(x) === pinId(p)) ? cur.filter((x) => pinId(x) !== pinId(p)) : [...cur, p]);
  },
};

export const useSeen = () => useSyncExternalStore(subscribe, seenStore.get);
export const usePinnedStacks = () => useSyncExternalStore(subscribe, pinStore.get);
