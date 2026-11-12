// One-time move of pre-accounts local state under the first account that signs in afterwards.
// Review drafts, guides and agent chats used to be keyed by PR/stack alone; they are now per login.

import { durable, type Ns } from "./durable";
import { hasViewerPrefix } from "./scope";

const NAMESPACES: Ns[] = ["review", "guide", "chat"];

/** Rows (key → prefixed key) that still use the old unprefixed keys. */
export function planAdoption(keys: string[], login: string): { from: string; to: string }[] {
  return keys.filter((k) => k && !hasViewerPrefix(k)).map((k) => ({ from: k, to: `${login}@${k}` }));
}

export function adoptLegacyRows(login: string): void {
  if (durable.get<boolean>("meta", "accountScopeAdopted", false)) return;
  for (const ns of NAMESPACES) {
    for (const { from, to } of planAdoption(Object.keys(durable.all(ns)), login)) {
      durable.set(ns, to, durable.get(ns, from, null));
      durable.delete(ns, from);
    }
  }
  durable.set("meta", "accountScopeAdopted", true);
}
