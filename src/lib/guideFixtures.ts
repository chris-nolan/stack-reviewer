// Demo ("?demo") guide data in the shape agents send to set_layer_guide / set_stack_guide, so the
// demo goes through the same validation as a real run.


export type DemoGuide = { layers: Record<number, Record<string, unknown>>; stack: Record<string, unknown> };

const RATE_LIMIT: DemoGuide = {
  layers: {
    412: {
      pr: 412, tier: "moderate",
      summary: "Adds a `TokenBucket` with capacity and a refill rate. Nothing calls it yet, so the layer is isolated and easy to test.",
      tier_reason: "small, but the time-based refill maths is easy to get subtly wrong",
      focus_areas: [
        { path: "src/limiter/tokenBucket.ts", start_line: 9, line: 18, title: "Refill with a zero rate", why: "A refill rate of 0 refills to full capacity instead of never refilling; check that is intended." },
        { path: "src/limiter/tokenBucket.ts", start_line: 27, line: 29, title: "Retry hint divides by the refill rate", why: "msUntilNextToken() divides by refillPerSec, which is 0 for a non-refilling bucket." },
      ],
      skim: [{ path: "src/limiter/index.ts", why: "one-line re-export" }],
      questions: ["Is Date.now() monotonic enough here, or should this use performance.now()?"],
    },
    413: {
      pr: 413, tier: "heavy",
      summary: "Mounts the limiter as global Express middleware keyed by client IP, with limits from a new `rateLimit` config block.",
      tier_reason: "touches every request, and the key, memory growth and ordering all matter",
      focus_areas: [
        { path: "src/middleware/rateLimit.ts", line: 8, title: "Keyed on req.ip", why: "Behind the load balancer req.ip is the proxy address, so every client may share one bucket." },
        { path: "src/middleware/rateLimit.ts", start_line: 9, line: 13, title: "Buckets are never evicted", why: "The map grows with every distinct key for the life of the process." },
        { path: "src/server.ts", start_line: 16, line: 17, title: "Mounted globally, before /health", why: "Health checks are limited too; check that load balancer probes can't be throttled." },
      ],
      skim: [{ path: "test/middleware/rateLimit.test.ts", why: "one straightforward 429 case" }],
      questions: ["Should this key on X-Forwarded-For?", "What should happen to the buckets map when a tenant goes quiet?"],
    },
    415: {
      pr: 415, tier: "moderate",
      summary: "Looks limits up per tenant from the `x-tenant` header with a global fallback, and keys buckets by tenant and IP.",
      tier_reason: "small diff, but it trusts a client-supplied header",
      focus_areas: [
        { path: "src/middleware/rateLimit.ts", start_line: 8, line: 10, title: "Tenant comes from a client header", why: "Any client can pick its own tenant, and so its own limit." },
        { path: "src/config/tenants.ts", start_line: 1, line: 4, title: "Hard-coded tenant table", why: "Limits live in code; check how they are meant to be changed." },
      ],
      skim: [],
      questions: ["Where do tenant limits come from after this? Config, or a database?"],
    },
    416: {
      pr: 416, tier: "light",
      summary: "Adds a rejected-requests counter labelled by tenant and records it from the middleware.",
      tier_reason: "mechanical wiring",
      focus_areas: [{ path: "src/metrics/limiter.ts", start_line: 3, line: 3, title: "Tenant as a metric label", why: "Unbounded label values blow up metric cardinality." }],
      skim: [],
      questions: [],
    },
    418: {
      pr: 418, tier: "light",
      summary: "Documents the limiter and adds a Grafana dashboard.",
      tier_reason: "docs and a generated dashboard",
      focus_areas: [{ path: "docs/rate-limiting.md", start_line: 5, line: 6, title: "Documented defaults", why: "Check these match the schema defaults from #413." }],
      skim: [{ path: "grafana/limiter.json", why: "generated dashboard JSON" }],
      questions: [],
    },
  },
  stack: {
    summary: "Adds request rate limiting to orders-api: a token bucket (#412), mounted globally by IP (#413), made per-tenant (#415), then observable (#416) and documented (#418).",
    layer_roles: [
      { pr: 412, role: "The token bucket itself" }, { pr: 413, role: "Global middleware and config" }, { pr: 415, role: "Per-tenant limits" },
      { pr: 416, role: "Rejection metrics" }, { pr: 418, role: "Docs and dashboard" },
    ],
    cross_layer: [
      { text: "#413 keys on IP, #415 re-keys on tenant + IP: the bucket map from #413 changes shape under it.", prs: [413, 415] },
      { text: "#416 labels metrics with the tenant introduced in #415; if tenants are client-supplied the label is unbounded.", prs: [415, 416] },
    ],
    plan: "Most of the risk is in **#413** (global middleware, keying, memory) and **#415** (trusting a header). #416 and #418 are mechanical.",
    ranking: [413, 415, 412, 416, 418],
  },
};

export function demoGuide(prs: number[]): DemoGuide | null {
  if (prs.includes(412)) return RATE_LIMIT;
  return null;
}
