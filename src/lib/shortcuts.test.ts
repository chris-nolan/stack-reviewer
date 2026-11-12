import { describe, expect, it } from "vitest";
import { detectMac, shortcut } from "./shortcuts";
import { parsePatch } from "./diff";

describe("shortcut labels", () => {
  it("uses ⌘ on mac and Ctrl elsewhere", () => {
    expect(shortcut("K", true)).toBe("⌘K");
    expect(shortcut("↵", false)).toBe("Ctrl+↵");
    expect(detectMac({ platform: "MacIntel" })).toBe(true);
    expect(detectMac({ platform: "Win32" })).toBe(false);
    expect(detectMac({})).toBe(false);
  });
});

describe("parsePatch with CRLF", () => {
  it("strips carriage returns from row text", () => {
    const rows = parsePatch("@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n");
    expect(rows.map((r) => r.kind)).toEqual(["hunk", "ctx", "del", "add"]);
    expect(rows.every((r) => r.kind === "hunk" || r.kind === "note" || !r.text.includes("\r"))).toBe(true);
    expect(rows[3]).toMatchObject({ kind: "add", text: "c", newLine: 2 });
  });
});
