// What changes when the signed-in account changes: cached data and running agents belong to the old account.

import { stopAllAgentSessions } from "../agent/session";

/**
 * Drops everything fetched with the previous account's token and stops running agent sessions
 * (their processes hold that token for git). Saved chats stay stored under their own account.
 */
export async function resetForAccountChange(qc: { clear: () => void }): Promise<void> {
  qc.clear();
  await stopAllAgentSessions();
}
