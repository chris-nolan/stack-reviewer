import { useEffect, useRef } from "react";
import { useInbox } from "./queries";
import { isTauri, local } from "../lib/platform";
import type { Stack } from "../lib/model";
import { repoKey } from "../lib/model";

type Seen = Record<string, { checks: string; stale: number[]; turn: number[] }>;

function snapshot(stacks: Stack[]): Seen {
  const out: Seen = {};
  for (const s of stacks) {
    out[`${repoKey(s.repo)}#${s.key}`] = {
      checks: s.checks,
      stale: s.layers.filter((l) => l.mine === "stale").map((l) => l.pr.number),
      turn: s.layers.filter((l) => l.mine === "turn").map((l) => l.pr.number),
    };
  }
  return out;
}

async function notify(title: string, body: string) {
  if (!isTauri() || !local.get("notifications", true)) return;
  const n = await import("@tauri-apps/plugin-notification");
  let ok = await n.isPermissionGranted();
  if (!ok) ok = (await n.requestPermission()) === "granted";
  if (ok) n.sendNotification({ title, body });
}

/** Watches the polled inbox and raises OS notifications for things that changed. */
export function Notifier() {
  const inbox = useInbox(local.get("includeSingles", false));
  const prev = useRef<Seen | null>(null);
  useEffect(() => {
    if (!inbox.data) return;
    const stacks = [...inbox.data.needsReview, ...inbox.data.mine];
    const now = snapshot(stacks);
    const before = prev.current;
    prev.current = now;
    if (!before) return; // first load: establish a baseline, don't notify
    for (const s of stacks) {
      const k = `${repoKey(s.repo)}#${s.key}`;
      const was = before[k];
      const is = now[k];
      if (!was) {
        if (is.turn.length) void notify("New stack to review", `${s.title} · ${s.repo.repo} · ${s.layers.length} layers`);
        continue;
      }
      if (is.checks === "fail" && was.checks !== "fail") void notify("Checks failing", `${s.title} · ${s.repo.repo}`);
      const newlyStale = is.stale.filter((n) => !was.stale.includes(n));
      if (newlyStale.length) void notify("New commits since your review", `${s.title}: #${newlyStale.join(", #")}`);
    }
  }, [inbox.data]);
  return null;
}
