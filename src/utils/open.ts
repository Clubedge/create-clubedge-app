import { spawn } from "node:child_process";
import process from "node:process";

/** The command that opens a URL in the default browser on this platform. */
export function openCommand(url: string, platform = process.platform): [string, string[]] {
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

/** Opens a URL in the default browser. Best effort: returns false when nothing could open it. */
export async function openUrl(url: string): Promise<boolean> {
  const [command, args] = openCommand(url);
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
