// Platform-aware keyboard shortcut labels: ⌘ on macOS, Ctrl elsewhere (Windows/Linux).
// Key handlers already accept `metaKey || ctrlKey`; this only affects what we display.

export function detectMac(nav: { platform?: string } | undefined = typeof navigator !== "undefined" ? navigator : undefined): boolean {
  return /Mac|iPhone|iPad/.test(nav?.platform ?? "");
}

export const isMac = detectMac();

/** Label for a modifier+key chord, e.g. `shortcut("K")` → "⌘K" or "Ctrl+K"; `shortcut("↵")` → "⌘↵" or "Ctrl+↵". */
export function shortcut(key: string, mac: boolean = isMac): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}
