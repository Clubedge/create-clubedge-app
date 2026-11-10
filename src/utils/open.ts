import { spawn } from "node:child_process";
import process from "node:process";

/** Only web URLs may reach an OS opener (which can otherwise launch local programs). */
export function assertWebUrl(url: string): URL {
  // Reject URL-parser fixups (backslashes, missing //, or surrounding whitespace)
  // before passing the original value to a platform-specific command.
  if (!/^https?:\/\//.test(url) || /[\\\s]/.test(url)) {
    throw new Error("Refusing to open a non-web URL");
  }
  const parsed = new URL(url);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new Error("Refusing to open a non-web URL");
  }
  return parsed;
}

/** The command that opens a URL in the default browser on this platform. */
export function openCommand(url: string, platform = process.platform): [string, string[]] {
  assertWebUrl(url);
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

/** Opens a URL in the default browser. Best effort: returns false when nothing could open it. */
export async function openUrl(url: string): Promise<boolean> {
  let command: string;
  let args: string[];
  try {
    [command, args] = openCommand(url);
  } catch {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
