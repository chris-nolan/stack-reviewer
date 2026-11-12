import { useQuery } from "@tanstack/react-query";
import { invoke, isTauri } from "../lib/platform";

export type AgentInfo = { id: "claude" | "gemini"; name: string; available: boolean; detail: string };

export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: async (): Promise<AgentInfo[]> => {
      if (!isTauri()) {
        return [
          { id: "claude", name: "Claude Code", available: false, detail: "Agents run in the desktop app" },
          { id: "gemini", name: "Gemini CLI", available: false, detail: "Agents run in the desktop app" },
        ];
      }
      return invoke<AgentInfo[]>("agents_detect");
    },
    staleTime: 5 * 60_000,
  });
}
