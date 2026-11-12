// Durable ("home" namespace) state that must not leak between data sources (demo / snapshot / real) or viewers.
import { durable } from "./durable";

let scope = "";
let viewerLogin = "";

/** Set when a session activates: `${source.label ?? source.kind}:${viewer.login}`, plus the login on its own. */
export function setStoreScope(s: string, login = "") {
  scope = s;
  viewerLogin = login;
}

/**
 * Prefixes a durable row key (review drafts, guides, agent chats) with the signed-in login, so two
 * accounts looking at the same PR never share drafts, a guide or a conversation. GitHub logins
 * can't contain "@" or "/", so a prefixed key is never confused with an unprefixed legacy one.
 */
export const viewerKey = (key: string): string => (viewerLogin ? `${viewerLogin}@${key}` : key);
export const hasViewerPrefix = (key: string): boolean => /^[A-Za-z0-9_-]+@/.test(key);
export const storeScope = () => scope;

const k = (key: string) => (scope ? `${key}:${scope}` : key);

export const scoped = {
  get: <T,>(key: string, fallback: T): T => durable.get<T>("home", k(key), fallback),
  set: (key: string, value: unknown) => durable.set("home", k(key), value),
};
