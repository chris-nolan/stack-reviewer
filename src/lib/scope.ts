// Durable ("home" namespace) state that must not leak between data sources (demo / snapshot / real) or viewers.
import { durable } from "./durable";

let scope = "";

/** Set when a session activates: `${source.label ?? source.kind}:${viewer.login}`. */
export function setStoreScope(s: string) {
  scope = s;
}
export const storeScope = () => scope;

const k = (key: string) => (scope ? `${key}:${scope}` : key);

export const scoped = {
  get: <T,>(key: string, fallback: T): T => durable.get<T>("home", k(key), fallback),
  set: (key: string, value: unknown) => durable.set("home", k(key), value),
};
