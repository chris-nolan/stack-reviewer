import { useQuery } from "@tanstack/react-query";
import { invoke, isTauri } from "../lib/platform";
import { launchOverrides } from "./config";

export type AgentInfo = { id: string; name: string; available: boolean; detail: string };

export function useAgents() {
  return useQuery({
    queryKey: ["agents", JSON.stringify(launchOverrides())],
    queryFn: async (): Promise<AgentInfo[]> => {
      if (!isTauri()) {
        return [
          { id: "claude", name: "Claude Code", available: false, detail: "Agents run in the desktop app" },
          { id: "gemini", name: "Gemini CLI", available: false, detail: "Agents run in the desktop app" },
        ];
      }
      return invoke<AgentInfo[]>("agents_detect", { overrides: launchOverrides() });
    },
    staleTime: 5 * 60_000,
  });
}
