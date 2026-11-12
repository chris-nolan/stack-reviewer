// Syntax highlighting with Shiki. Grammars load on demand; very large inputs fall back to plain text.

import { bundledLanguages, bundledLanguagesAlias, getSingletonHighlighter, type BundledLanguage } from "shiki";

export type LineTokens = { content: string; color?: string }[];

const THEME = "github-dark-default";
const MAX_CHARS = 400_000;
const MAX_LINES = 15_000;

const BY_FILENAME: Record<string, string> = {
  dockerfile: "docker", makefile: "make", "cmakelists.txt": "cmake", jenkinsfile: "groovy",
  ".gitignore": "shellscript", ".env": "dotenv", "go.mod": "go",
};
const BY_EXT: Record<string, string> = {
  csproj: "xml", props: "xml", targets: "xml", sln: "text", config: "xml", resx: "xml", xaml: "xml",
  mts: "typescript", cts: "typescript", mjs: "javascript", cjs: "javascript",
  h: "c", hpp: "cpp", cc: "cpp", kt: "kotlin", kts: "kotlin", tf: "hcl", proto: "proto", lock: "text",
};

/** Shiki language id for a path, or null for plain text. */
export function languageFor(path: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  if (BY_FILENAME[name]) return BY_FILENAME[name];
  if (name.startsWith("dockerfile")) return "docker";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  const id = BY_EXT[ext] ?? ext;
  if (id === "text" || !id) return null;
  if (id in bundledLanguages) return id;
  const alias = (bundledLanguagesAlias as Record<string, unknown>)[id];
  return alias ? id : null;
}

let highlighter: ReturnType<typeof getSingletonHighlighter> | null = null;
const loaded = new Set<string>();

/** Colours each line of `code`. Returns null when the language is unknown or the input too big. */
export async function tokenize(code: string, path: string): Promise<LineTokens[] | null> {
  const lang = languageFor(path);
  if (!lang || code.length > MAX_CHARS) return null;
  if (code.split("\n").length > MAX_LINES) return null;
  highlighter ??= getSingletonHighlighter({ themes: [THEME], langs: [] });
  const hl = await highlighter;
  if (!loaded.has(lang)) {
    await hl.loadLanguage(lang as BundledLanguage);
    loaded.add(lang);
  }
  const lines = hl.codeToTokensBase(code, { lang: lang as BundledLanguage, theme: THEME });
  return lines.map((ts) => ts.map((t) => ({ content: t.content, color: t.color })));
}
