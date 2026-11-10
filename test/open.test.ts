import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { assertWebUrl, openCommand, openUrl } from "../src/utils/open.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("safe browser opener", () => {
  it("allows HTTP and HTTPS URLs on each platform", () => {
    for (const url of ["http://localhost:3000/", "https://example.org/path?a=1"]) {
      expect(assertWebUrl(url).href).toBe(url);
      expect(openCommand(url, "win32")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", url]]);
      expect(openCommand(url, "darwin")).toEqual(["open", [url]]);
      expect(openCommand(url, "linux")).toEqual(["xdg-open", [url]]);
    }
  });

  it.each([
    "C:\\Windows\\System32\\calc.exe",
    "C:\\scripts\\run.bat",
    "\\\\server\\share\\payload.bat",
    "file:///etc/passwd",
    "ms-msdt:/id/PCWDiagnostic",
    "javascript:alert(1)",
    "--help",
    "-https://example.org",
    "https:example.org",
    "https:\\example.org",
    " https://example.org",
    "https://example.org\n",
    "not a URL",
    "https://",
  ])("rejects non-web or malformed target %s", async (url) => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(() => openCommand(url, platform)).toThrow();
    }
    // Rejected targets must never launch an OS process, even on a failure path.
    vi.mocked(spawn).mockClear();
    await expect(openUrl(url)).resolves.toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
