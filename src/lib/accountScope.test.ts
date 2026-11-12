import { describe, expect, it } from "vitest";
import { planAdoption } from "./accountScope";
import { hasViewerPrefix, scoped, setStoreScope, viewerKey } from "./scope";
import { prKey } from "./reviewStore";

describe("per-account local state", () => {
  it("prefixes review, guide and chat keys with the login", () => {
    setStoreScope("github:alex-r", "alex-r");
    expect(prKey({ owner: "acme", repo: "orders-api" }, 12)).toBe("alex-r@acme/orders-api#12");
    setStoreScope("github:priya-k", "priya-k");
    expect(prKey({ owner: "acme", repo: "orders-api" }, 12)).toBe("priya-k@acme/orders-api#12");
    setStoreScope("", "");
    expect(viewerKey("x")).toBe("x");
  });

  it("tells legacy keys from prefixed ones", () => {
    expect(hasViewerPrefix("alex-r@acme/orders-api#12")).toBe(true);
    expect(hasViewerPrefix("acme/orders-api#12")).toBe(false);
    expect(hasViewerPrefix("acme/orders-api#feat@x|claude")).toBe(false);
  });

  it("adopts only legacy rows", () => {
    expect(planAdoption(["acme/orders-api#1", "priya-k@acme/orders-api#1", ""], "alex-r")).toEqual([
      { from: "acme/orders-api#1", to: "alex-r@acme/orders-api#1" },
    ]);
  });

  it("keeps seen/pins/recent separate per source and viewer", () => {
    setStoreScope("github:alex-r", "alex-r");
    scoped.set("pinnedRepos", [{ owner: "acme", repo: "orders-api" }]);
    setStoreScope("github:priya-k", "priya-k");
    expect(scoped.get("pinnedRepos", [])).toEqual([]);
    setStoreScope("github:alex-r", "alex-r");
    expect(scoped.get("pinnedRepos", [])).toHaveLength(1);
    setStoreScope("", "");
  });
});
