// Local state that must not leak between data sources (demo / snapshot / real) or viewers.
import { local } from "./platform";

let scope = "";

/** Set when a session activates: `${source.label ?? source.kind}:${viewer.login}`. */
export function setStoreScope(s: string) {
  scope = s;
}
export const storeScope = () => scope;

const k = (key: string) => (scope ? `${key}:${scope}` : key);

export const scoped = {
  get: <T,>(key: string, fallback: T): T => local.get<T>(k(key), fallback),
  set: (key: string, value: unknown) => local.set(k(key), value),
};
