// Normalises the model / effort choices agents advertise over ACP into one shape.
// Claude Code uses session config options (categories "model" and "thought_level");
// Gemini CLI still uses the older `models` state with `session/set_model`.

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { local } from "../lib/platform";

export type SettingKind = "model" | "effort";

export type AgentSetting = {
  kind: SettingKind;
  id: string; // config option id, or "model" for the legacy model API
  via: "config" | "models";
  name: string;
  current: string;
  options: { value: string; name: string; description?: string }[];
};

type LegacyModels = { currentModelId: string; availableModels: { modelId: string; name: string; description?: string | null }[] } | null | undefined;

export type SessionState = {
  configOptions?: SessionConfigOption[] | null;
  models?: LegacyModels;
  modes?: { currentModeId: string; availableModes: { id: string; name: string }[] } | null;
};

function flatten(o: SessionConfigOption): AgentSetting["options"] {
  if (o.type !== "select") return [];
  const opts = o.options as unknown as ({ value: string; name: string; description?: string | null } | { group: string; options: { value: string; name: string; description?: string | null }[] })[];
  return opts.flatMap((x) => ("group" in x ? x.options : [x])).map((x) => ({ value: x.value, name: x.name, description: x.description ?? undefined }));
}

export function readSettings(s: SessionState): AgentSetting[] {
  const out: AgentSetting[] = [];
  for (const o of s.configOptions ?? []) {
    if (o.type !== "select") continue;
    const kind: SettingKind | null = o.category === "model" ? "model" : o.category === "thought_level" ? "effort" : null;
    if (!kind || out.some((x) => x.kind === kind)) continue;
    out.push({ kind, id: o.id, via: "config", name: o.name, current: String(o.currentValue), options: flatten(o) });
  }
  if (!out.some((x) => x.kind === "model") && s.models?.availableModels?.length) {
    out.push({
      kind: "model", id: "model", via: "models", name: "Model", current: s.models.currentModelId,
      options: s.models.availableModels.map((m) => ({ value: m.modelId, name: m.name, description: m.description ?? undefined })),
    });
  }
  return out.sort((a, b) => (a.kind === "model" ? -1 : 1) - (b.kind === "model" ? -1 : 1));
}

/** The reviewer's chosen values per agent, applied whenever a session starts. */
export type AgentPrefs = Partial<Record<SettingKind, string>>;
export const prefs = {
  get: (agentId: string): AgentPrefs => local.get(`agentPrefs.${agentId}`, {}),
  set: (agentId: string, kind: SettingKind, value: string) => local.set(`agentPrefs.${agentId}`, { ...prefs.get(agentId), [kind]: value }),
};

/** Last settings seen per agent, so the pickers are populated before a session starts. */
export const knownSettings = {
  get: (agentId: string): AgentSetting[] => local.get(`agentSettings.${agentId}`, []),
  set: (agentId: string, s: AgentSetting[]) => local.set(`agentSettings.${agentId}`, s),
};
