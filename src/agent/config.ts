// User-entered agent commands (Settings). Only these are ever passed to Rust as overrides.
import { local } from "../lib/platform";

export type AgentCommand = { command: string; args: string };
export type CustomAgent = AgentCommand & { id: string; name: string };
export type LaunchOverride = { id: string; name: string; command: string; args: string[] };

export const agentConfig = {
  overrides: (): Record<string, AgentCommand> => local.get("agentOverrides", {}),
  setOverrides: (o: Record<string, AgentCommand>) => local.set("agentOverrides", o),
  custom: (): CustomAgent[] => local.get("customAgents", []),
  setCustom: (c: CustomAgent[]) => local.set("customAgents", c),
};

/** Splits an args string on whitespace, honouring "double" and 'single' quotes. */
export function parseArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Everything Rust needs: overrides for built-in agents plus custom agents, in launch form. */
export function launchOverrides(): LaunchOverride[] {
  const list: LaunchOverride[] = [];
  for (const [id, o] of Object.entries(agentConfig.overrides())) {
    if (o.command.trim()) list.push({ id, name: "", command: o.command.trim(), args: parseArgs(o.args) });
  }
  for (const c of agentConfig.custom()) {
    if (c.command.trim()) list.push({ id: c.id, name: c.name.trim() || c.id, command: c.command.trim(), args: parseArgs(c.args) });
  }
  return list;
}

export const launchFor = (id: string): LaunchOverride | undefined => launchOverrides().find((o) => o.id === id);
