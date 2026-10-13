// Joins the scenes recorded by director.mjs into one video with a timeline.
//   node compose.mjs <output-directory>
// Terminal scenes are rendered by agg (asciinema's renderer), browser scenes come from Playwright;
// both become 1280x800 at 30 fps, then ffmpeg concatenates them. Writes walkthrough.mp4,
// poster.jpg and walkthrough.json (each scene's kind, label, start, end, and the browser's URLs).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
const recorded = JSON.parse(readFileSync(join(out, "scenes.json"), "utf8"));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString();
const duration = (file) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]));

// The site's terminal palette: background, foreground, then the 16 ANSI colors.
const theme = [
  "14151a", "e8e8ee",
  "14151a", "f87171", "8be0a8", "fbbf24", "60a5fa", "e879f9", "67e8f9", "d4d4dc",
  "6b6d78", "fca5a5", "a7f3c4", "fde68a", "93c5fd", "f0abfc", "a5f3fc", "ffffff",
].join(",");
const frame = "fps=30,scale=1280:800:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0x14151a,setsar=1,format=yuv420p";
const encode = ["-c:v", "libx264", "-preset", "slow", "-crf", "26", "-r", "30", "-an"];

const segments = [];
recorded.scenes.forEach((scene, i) => {
  const segment = join(out, `segment-${i}.mp4`);
  if (scene.kind === "terminal") {
    const gif = join(out, `scene-${i}.gif`);
    run("agg", [
      "--theme", theme,
      "--font-family", "JetBrains Mono,DejaVu Sans Mono",
      "--font-size", "22",
      "--line-height", "1.3",
      "--idle-time-limit", "1.5",
      "--last-frame-duration", "1",
      join(out, scene.file), gif,
    ]);
    run("ffmpeg", ["-y", "-v", "error", "-i", gif, "-vf", frame, ...encode, segment]);
  } else {
    run("ffmpeg", ["-y", "-v", "error", "-ss", String(scene.trim), "-i", join(out, scene.file), "-vf", frame, ...encode, segment]);
  }
  segments.push(segment);
});

writeFileSync(join(out, "segments.txt"), segments.map((s) => `file '${s}'`).join("\n") + "\n");
const video = join(out, "walkthrough.mp4");
run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", join(out, "segments.txt"), "-c", "copy", "-movflags", "+faststart", video]);

// Stripe's Checkout and portal URLs carry session ids and secrets: keep only where the page is.
const shownUrl = (url) => {
  const u = new URL(url);
  if (!u.hostname.endsWith("stripe.com")) return url;
  return `${u.origin}${u.pathname.split("/").slice(0, 3).join("/")}/…`;
};

let start = 0;
const scenes = recorded.scenes.map((scene, i) => {
  const length = duration(segments[i]);
  const entry = {
    kind: scene.kind,
    label: scene.label,
    start: Number(start.toFixed(2)),
    end: Number((start + length).toFixed(2)),
    ...(scene.kind === "browser"
      ? {
          urls: scene.urls.map(({ t, url }) => ({
            t: Number(Math.min(start + length, Math.max(start, start + t - scene.trim)).toFixed(2)),
            url: shownUrl(url),
          })),
        }
      : {}),
  };
  start += length;
  return entry;
});

// The poster is a moment from the first browser scene.
const shown = scenes.find((s) => s.kind === "browser") ?? scenes[0];
run("ffmpeg", ["-y", "-v", "error", "-ss", String((shown.start + shown.end) / 2), "-i", video, "-frames:v", "1", "-q:v", "3", join(out, "poster.jpg")]);

const { scenes: _, ...meta } = recorded;
writeFileSync(join(out, "walkthrough.json"), JSON.stringify({ ...meta, duration: Number(start.toFixed(2)), scenes }, null, 2) + "\n");
console.log(`walkthrough.mp4: ${scenes.length} scenes, ${start.toFixed(1)}s`);
