// Sidebar file-list filters for the review screen. Pure logic.

export type FileFilter = "all" | "unviewed" | "findings" | "comments" | "focus";
export type FileFilters = { kind: FileFilter; ext: string | null; /** Hide files the guide says are safe to skim. */ hideSkim?: boolean };
export const NO_FILTER: FileFilters = { kind: "all", ext: null };

export type FileFacts = { path: string; viewed: boolean; openFindings: number; openThreads: number; drafts: number; /** Guide focus areas in the file. */ focus?: number; /** The guide marks the file as safe to skim. */ skim?: boolean };

export const fileExt = (path: string): string => {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "other";
};

const kindMatches = (f: FileFacts, kind: FileFilter) =>
  kind === "all" ? true : kind === "unviewed" ? !f.viewed : kind === "findings" ? f.openFindings > 0 : kind === "focus" ? (f.focus ?? 0) > 0 : f.openThreads + f.drafts > 0;

export function applyFileFilters<T extends FileFacts>(files: T[], filters: FileFilters, currentPath?: string | null): T[] {
  return files.filter(
    (f) => f.path === currentPath || (kindMatches(f, filters.kind) && (!filters.ext || fileExt(f.path) === filters.ext) && !(filters.hideSkim && f.skim)),
  );
}

export function filterCounts(files: FileFacts[]): Record<FileFilter, number> {
  return {
    all: files.length,
    unviewed: files.filter((f) => kindMatches(f, "unviewed")).length,
    findings: files.filter((f) => kindMatches(f, "findings")).length,
    comments: files.filter((f) => kindMatches(f, "comments")).length,
    focus: files.filter((f) => kindMatches(f, "focus")).length,
  };
}

/** Extensions present in the layer with counts, most common first; empty unless there is more than one type. */
export function extensionChips(files: { path: string }[]): { ext: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const e = fileExt(f.path);
    counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  if (counts.size < 2) return [];
  return [...counts].map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
}
