import process from "node:process";
import { cliUrl, cliVersion, siteUrl, starterPin } from "../package-info.js";

// Each glyph is 6 rows tall. Rows are padded to a common width when rendered.
const glyphs: Record<string, string[]> = {
  C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
  L: ["██╗     ", "██║     ", "██║     ", "██║     ", "███████╗", "╚══════╝"],
  U: ["██╗   ██╗", "██║   ██║", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  B: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
};

function renderWord(word: string): string[] {
  const letters = [...word].map((letter) => {
    const rows = glyphs[letter]!;
    const width = Math.max(...rows.map((row) => row.length));
    return rows.map((row) => row.padEnd(width, " "));
  });
  return letters[0]!.map((_, rowIndex) => letters.map((letter) => letter[rowIndex]).join(""));
}

const colorEnabled =
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
type Rgb = [number, number, number];
const paint = (rgb: Rgb, value: string) =>
  colorEnabled ? `\x1b[38;2;${rgb.join(";")}m${value}\x1b[0m` : value;
export const dim = (value: string) => (colorEnabled ? `\x1b[2m${value}\x1b[0m` : value);
export const bold = (value: string) => (colorEnabled ? `\x1b[1m${value}\x1b[0m` : value);

// Light violet -> Clubedge brand violet, top to bottom across the banner.
const gradientFrom: Rgb = [165, 140, 255];
const gradientTo: Rgb = [91, 61, 245];
const mix = (from: Rgb, to: Rgb, t: number): Rgb =>
  from.map((channel, index) => Math.round(channel + (to[index]! - channel) * t)) as Rgb;

export function showBanner(): void {
  // Stay quiet when output is piped (CI, logs, scripts).
  if (!process.stdout.isTTY) return;

  const columns = process.stdout.columns ?? 80;
  const lines = [...renderWord("CLUBEDGE"), ...renderWord("STARTER")];
  const widest = Math.max(...lines.map((line) => line.length));

  console.log("");
  if (columns >= widest + 2) {
    lines.forEach((line, index) => {
      console.log(paint(mix(gradientFrom, gradientTo, index / (lines.length - 1)), line));
    });
  } else {
    // Narrow terminal: compact wordmark instead of wrapping the big letters.
    console.log(paint(gradientTo, bold("CLUBEDGE STARTER")));
  }
  console.log("");
  console.log(
    `  ${bold("create-clubedge-app")} ${dim(`v${cliVersion}`)}  ${dim("·")}  ${paint(gradientFrom, cliUrl)}`,
  );
  console.log(`  ${dim("By Clubedge")}  ${dim("·")}  ${paint(gradientFrom, siteUrl)}`);
  console.log("");
}

export function helpText(): string {
  return `
create-clubedge-app ${cliVersion}

Create a project from the Clubedge Starter reference repository.
This CLI release scaffolds Starter ${starterPin.starterRef} (commit ${starterPin.starterCommit}).

Usage:
  pnpm dlx @clubedge/create-clubedge-app [project-directory] [options]
  pnpm dlx @clubedge/create-clubedge-app add <module> <option>   (inside a project)
  pnpm dlx @clubedge/create-clubedge-app remove <module>         (inside a project)

  add and remove change one module of an existing project and merge the change
  into your code; lines you changed that the module also changes get conflict
  markers. Commit first so you can review the result with git diff.

Options:
  --framework <id>        App framework: next (default) or tanstack-start
  --auth <id>             Authentication: supabase (default), better-auth, or none
  --storage <id>          File storage: s3 (default), supabase, or none
  --cache <id>            Cache and rate limits: redis (default) or memory
  --infra <id>            Local services: docker (default), supabase, local, or none
  --ref <ref>             Download this Starter tag, branch, or commit from GitHub instead
  --template-dir <path>   Scaffold from a local Starter checkout (for Starter development)
  --dry-run               Show what would be created or changed without writing anything
  --force                 add/remove: change a project with uncommitted changes or without Git
  -y, --yes               Accept defaults and never prompt (default directory: my-app)
  --no-install            Skip dependency installation
  --no-git                Skip Git repository initialization
  -h, --help              Show this help
  -v, --version           Show the CLI version

Examples:
  pnpm dlx @clubedge/create-clubedge-app my-app
  pnpm dlx @clubedge/create-clubedge-app my-app --framework tanstack-start
  pnpm dlx @clubedge/create-clubedge-app my-app --auth none --storage none --cache memory
  pnpm dlx @clubedge/create-clubedge-app my-app --dry-run
  pnpm dlx @clubedge/create-clubedge-app my-app --ref main
  pnpm dlx @clubedge/create-clubedge-app my-app --template-dir ../clubedge-starter
  pnpm dlx @clubedge/create-clubedge-app add auth better-auth
  pnpm dlx @clubedge/create-clubedge-app remove storage --dry-run

Learn more:
  CLI      ${cliUrl}
  Clubedge ${siteUrl}
`;
}
