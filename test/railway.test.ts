import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import {
  hostKeyFingerprint,
  lastVmPath,
  parseRailwayStatus,
  portForwardCommand,
  proxySource,
  railwayKeyPath,
  shellQuote,
  trustedHostKeys,
  tryCreateArgs,
  tryModules,
  tryScript,
  vmPhase,
} from "../src/core/railway.js";

// The status line as railway.new prints it on stderr (claim code replaced).
const statusLine = JSON.stringify({
  status: "trial_ready",
  state: "running",
  description: "Railway VM, provided until build_expires_at.",
  usage: { run: "ssh railway.new COMMAND_HERE" },
  preview_url: "https://preview-49b3bb1ddde053a5.up.railway.app",
  human_claim_url: "https://railway.com/ssh-signup?code=example",
  build_expires_at: "2026-10-13T12:11:44Z",
});

describe("Railway status", () => {
  it("finds the status line among other stderr output", () => {
    const vm = parseRailwayStatus(`Warning: something\n${statusLine}\nmore`);
    expect(vm).toEqual({
      status: "trial_ready",
      state: "running",
      previewUrl: "https://preview-49b3bb1ddde053a5.up.railway.app",
      claimUrl: "https://railway.com/ssh-signup?code=example",
      expiresAt: new Date("2026-10-13T12:11:44Z"),
    });
  });

  it("returns null without a status line", () => {
    expect(parseRailwayStatus("")).toBeNull();
    expect(parseRailwayStatus("{not json}\n{\"other\":1}")).toBeNull();
  });

  it("fails clearly when Railway changes the fields", () => {
    expect(() => parseRailwayStatus(JSON.stringify({ status: "trial_ready", preview_url: "http://insecure" }))).toThrow(
      /not as this CLI expects/,
    );
  });
});

describe("Railway host key", () => {
  it("formats fingerprints as OpenSSH does", () => {
    expect(hostKeyFingerprint(Buffer.from("abc"))).toBe("SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0");
  });

  it("pins Railway's key and accepts extra keys from the environment", () => {
    expect(trustedHostKeys({})).toEqual(["SHA256:+S1xg92FrnHz6pY3bpkmh1OGtWQGNANXilPzlxA7B1g"]);
    expect(trustedHostKeys({ CLUBEDGE_RAILWAY_HOST_KEY: " SHA256:a , SHA256:b " })).toHaveLength(3);
  });
});

describe("Railway key path", () => {
  it("keeps the key in the CLI's own config directory", () => {
    expect(railwayKeyPath({ XDG_CONFIG_HOME: "/cfg" }, "linux")).toBe(join("/cfg", "clubedge", "railway_ed25519"));
    expect(railwayKeyPath({ APPDATA: "C:/Users/a/AppData/Roaming" }, "win32")).toBe(
      join("C:/Users/a/AppData/Roaming", "clubedge", "railway_ed25519"),
    );
    expect(railwayKeyPath({}, "linux")).toMatch(/[\\/]\.config[\\/]clubedge[\\/]railway_ed25519$/);
  });
});

describe("try selection", () => {
  it("defaults to what the VM can run", () => {
    expect(tryModules({})).toEqual({ infra: "local", auth: "better-auth", email: "none" });
  });

  it("keeps the user's flags", () => {
    expect(tryModules({ auth: "none", cache: "memory", email: "smtp" })).toEqual({
      infra: "local",
      auth: "none",
      cache: "memory",
      email: "smtp",
    });
  });

  it("rejects what needs Docker or a Supabase project", () => {
    expect(() => tryModules({ infra: "docker" })).toThrow(/--infra local/);
    expect(() => tryModules({ auth: "supabase" })).toThrow(/Supabase Auth/);
  });

  it("builds the create flags", () => {
    expect(tryCreateArgs({ framework: "tanstack-start", modules: { infra: "local" }, ref: "v0.15.0" })).toEqual([
      "--framework",
      "tanstack-start",
      "--infra",
      "local",
      "--ref",
      "v0.15.0",
      "--yes",
    ]);
  });
});

describe("try script", () => {
  const options = {
    source: { kind: "create", cliVersion: "1.2.3" } as const,
    modules: tryModules({}),
    previewUrl: "https://preview-x.up.railway.app",
  };
  const uploaded = {
    source: { kind: "upload", name: "acme-web" } as const,
    modules: { infra: "local", auth: "better-auth" },
    previewUrl: "https://preview-x.up.railway.app",
  };

  it("creates the project with this CLI version and quoted flags", () => {
    const script = tryScript(options);
    expect(script).toContain(`pnpm dlx @clubedge/create-clubedge-app@1.2.3 "$dir" '--infra' 'local' '--auth' 'better-auth' '--email' 'none' '--yes'`);
    expect(script).toContain("BETTER_AUTH_SECRET");
    expect(script).toContain("'https://preview-x.up.railway.app'");
    expect(script).toContain("@@ready");
  });

  it("unpacks and installs an uploaded project, then makes its env files", () => {
    const script = tryScript(uploaded);
    expect(script).toContain("base='acme-web'");
    expect(script).toContain("tar xzf /app/clubedge-upload.tgz");
    expect(script).toContain("pnpm install");
    expect(script).toContain('cp "$example" "$target"');
    // A generated project keeps its example at the root and its env file in apps/web.
    expect(script).toContain("cp .env.example apps/web/.env.local");
    expect(script).not.toContain("create-clubedge-app@");
  });

  it("starts the local database only with infra local", () => {
    expect(tryScript(uploaded)).toContain("pnpm infra:up");
    expect(tryScript({ ...uploaded, modules: { infra: "none", auth: "none" } })).not.toContain("pnpm infra:up");
  });

  it("only sets a Better Auth secret when Better Auth is used", () => {
    expect(tryScript({ ...options, modules: tryModules({ auth: "none" }) })).not.toContain("BETTER_AUTH_SECRET");
  });

  const hasBash = spawnSync("bash", ["--version"]).status === 0;
  // BSD sed, on macOS, takes -i differently; the VM runs Linux.
  it.skipIf(!hasBash || process.platform === "darwin")("reads the client's address from the header Railway's edge sets", () => {
    const script = tryScript(uploaded);
    const start = script.indexOf("for envfile in");
    const loop = script.slice(start, script.indexOf("\ndone", start) + 5);
    expect(loop).toContain("CLIENT_IP_HEADER=x-real-ip");
    const dir = mkdtempSync(join(tmpdir(), "clubedge-try-"));
    try {
      for (const app of ["web", "api"]) {
        mkdirSync(join(dir, "apps", app), { recursive: true });
        writeFileSync(join(dir, "apps", app, ".env.local"), "CLIENT_IP_HEADER=\nPORT=3000\n");
      }
      const result = spawnSync("bash", ["-c", loop], { cwd: dir, encoding: "utf8" });
      expect(result.stderr).toBe("");
      for (const app of ["web", "api"]) {
        expect(readFileSync(join(dir, "apps", app, ".env.local"), "utf8")).toBe("PORT=3000\nCLIENT_IP_HEADER=x-real-ip\n");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quotes values so they stay one word", () => {
    expect(shellQuote("a'; rm -rf /")).toBe(`'a'\\''; rm -rf /'`);
  });

  it.skipIf(!hasBash)("is valid bash", () => {
    for (const script of [tryScript(options), tryScript(uploaded), tryScript({ ...uploaded, modules: { infra: "none" } })]) {
      const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });

  it("ships a proxy that is valid JavaScript", () => {
    const dir = mkdtempSync(join(tmpdir(), "clubedge-proxy-"));
    try {
      const file = join(dir, "proxy.mjs");
      writeFileSync(file, proxySource);
      const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseCliArgs try", () => {
  it("takes the create selection flags", () => {
    const args = parseCliArgs(["try", "--framework", "tanstack-start", "--auth", "none", "--yes"]);
    expect(args.command).toEqual({ name: "try" });
    expect(args.framework).toBe("tanstack-start");
    expect(args.modules).toEqual({ auth: "none" });
    expect(args.yes).toBe(true);
  });

  it("rejects a directory and --template-dir", () => {
    expect(() => parseCliArgs(["try", "my-app"])).toThrow(/Usage: try/);
    expect(() => parseCliArgs(["try", "--template-dir", "../starter"])).toThrow(/--template-dir/);
  });

  it("takes --claim and --status, for try only", () => {
    expect(parseCliArgs(["try", "--claim"])).toMatchObject({ claim: true, status: false });
    expect(parseCliArgs(["try", "--status"])).toMatchObject({ claim: false, status: true });
    expect(() => parseCliArgs(["my-app", "--claim"])).toThrow(/only apply to try/);
    expect(() => parseCliArgs(["doctor", "--status"])).toThrow(/only apply to try/);
  });
});

describe("the last VM", () => {
  const vm = {
    previewUrl: "https://preview-x.up.railway.app",
    claimUrl: "https://railway.com/ssh-signup?code=example",
    expiresAt: "2026-10-13T12:00:00Z",
    directory: "/app/my-app",
  };

  it("runs for its 60 minutes, stays claimable for 24 hours after, then is gone", () => {
    expect(vmPhase(vm, new Date("2026-10-13T11:20:00Z"))).toMatchObject({ phase: "running", minutesLeft: 40 });
    expect(vmPhase(vm, new Date("2026-10-13T18:00:00Z"))).toMatchObject({ phase: "claimable", minutesLeft: 0 });
    expect(vmPhase(vm, new Date("2026-10-14T12:00:01Z")).phase).toBe("gone");
    expect(vmPhase(vm).claimUntil.toISOString()).toBe("2026-10-14T12:00:00.000Z");
  });

  it("is saved next to the CLI's key", () => {
    expect(lastVmPath({ XDG_CONFIG_HOME: "/cfg" }, "linux")).toBe(join("/cfg", "clubedge", "railway-vm.json"));
  });

  it("forwards the app to localhost with the CLI's own key", () => {
    expect(portForwardCommand("/cfg/clubedge/railway_ed25519")).toBe(
      'ssh -i "/cfg/clubedge/railway_ed25519" -N -L 3000:127.0.0.1:3000 railway.new',
    );
  });
});
