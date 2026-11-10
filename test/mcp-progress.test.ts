// Progress notifications while create_project installs dependencies: the steps on their own, then
// the tool over an in-memory connection. The clock, pnpm, and the toolchain are replaced, so
// nothing is installed and no test waits.
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  InMemoryTransport,
  type CallToolResult,
  type JSONRPCMessage,
  type McpServerFactory,
  type ProgressNotificationParams,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stepProgress, type ProgressRequest } from "../src/mcp-progress.js";
import { detectPnpm, installDependencies } from "../src/steps/install.js";
import { commandSucceeds, run } from "../src/utils/process.js";
import { appStarterFiles, temporaryDirectory, writeFiles } from "./helpers.js";

// Importing the server starts it on stdio; the tests take its factory and serve it in memory.
vi.mock("@modelcontextprotocol/server/stdio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modelcontextprotocol/server/stdio")>()),
  serveStdio: vi.fn(),
}));

vi.mock("../src/core/source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/source.js")>();
  return { ...actual, resolveTemplateSource: vi.fn(async () => actual.readDirectoryTemplate(starter)) };
});

vi.mock("../src/steps/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/steps/install.js")>()),
  detectPnpm: vi.fn(),
  installDependencies: vi.fn(),
}));

vi.mock("../src/utils/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/process.js")>()),
  commandSucceeds: vi.fn(),
  run: vi.fn(),
}));

/** The fixture Starter that the replaced template source reads. */
let starter: string;

/** An install that says when it was started, and ends when the test says. */
function fakeInstall() {
  let started!: () => void;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const whenStarted = new Promise<void>((resolve) => (started = resolve));
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return {
    started: whenStarted,
    run: () => {
      started();
      return done;
    },
    finish,
    fail,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("stepProgress", () => {
  /** The part of a tool call that progress reads, with the notifications sent to it. */
  function toolCall(progressToken?: string | number) {
    const cancel = new AbortController();
    const notify = vi.fn<ProgressRequest["notify"]>(async () => {});
    const request: ProgressRequest = { _meta: progressToken === undefined ? undefined : { progressToken }, signal: cancel.signal, notify };
    const sent = () => notify.mock.calls.map(([notification]) => notification.params as unknown as ProgressNotificationParams);
    return { request, notify, cancel, sent, messages: () => sent().map(({ message }) => message) };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("tells a client with a token when a step starts, every five seconds while it runs, and when it ends", async () => {
    const call = toolCall("install-1");
    const install = fakeInstall();
    const step = stepProgress(call.request).step("pnpm install", async () => {
      await install.run();
      return "installed";
    });
    expect(call.messages()).toEqual(["pnpm install: started"]);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(call.messages()).toEqual(["pnpm install: started", "pnpm install: running for 5s", "pnpm install: running for 10s"]);

    install.finish();
    expect(await step).toBe("installed");
    expect(call.notify).toHaveBeenLastCalledWith({
      method: "notifications/progress",
      params: { progressToken: "install-1", progress: 4, message: "pnpm install: finished in 12s" },
    });
    expect(call.sent().map(({ progress }) => progress)).toEqual([1, 2, 3, 4]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing without a token, and starts no timer", async () => {
    const call = toolCall();
    const install = fakeInstall();
    const step = stepProgress(call.request).step("pnpm install", async () => {
      await install.run();
      return "installed";
    });
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(12_000);
    install.finish();
    expect(await step).toBe("installed");
    expect(call.notify).not.toHaveBeenCalled();
  });

  it("clears its timer when a step fails, and passes the error on", async () => {
    const call = toolCall(7);
    const install = fakeInstall();
    const failed = expect(stepProgress(call.request).step("uv sync in apps/api", install.run)).rejects.toThrow("uv exited with code 1.");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(7_000);
    install.fail(new Error("uv exited with code 1."));
    await failed;
    expect(call.messages()).toEqual([
      "uv sync in apps/api: started",
      "uv sync in apps/api: running for 5s",
      "uv sync in apps/api: failed after 7s",
    ]);
    expect(call.sent().every(({ progressToken }) => progressToken === 7)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(call.sent()).toHaveLength(3);
  });

  it("keeps the values increasing from one step to the next, and gives no total", async () => {
    const call = toolCall("install-1");
    const progress = stepProgress(call.request);
    for (const name of ["pnpm install", "uv sync in apps/api"]) {
      const step = progress.step(name, () => new Promise<void>((resolve) => setTimeout(resolve, 63_000)));
      await vi.advanceTimersByTimeAsync(63_000);
      await step;
    }

    // Each step: its start, twelve times while it runs, and its end.
    const values = call.sent().map(({ progress: value }) => value);
    expect(values).toHaveLength(28);
    expect(values).toEqual(values.map((_, index) => index + 1));
    expect(call.sent().every(({ total }) => total === undefined)).toBe(true);
    expect(call.messages().slice(-2)).toEqual(["uv sync in apps/api: running for 1m 0s", "uv sync in apps/api: finished in 1m 3s"]);
  });

  it("finishes a step whose notifications cannot be sent", async () => {
    const call = toolCall("install-1");
    call.notify.mockRejectedValueOnce(new Error("StdioServerTransport is closed")).mockImplementationOnce(() => {
      throw new Error("Not connected");
    });
    const install = fakeInstall();
    const step = stepProgress(call.request).step("pnpm install", async () => {
      await install.run();
      return "installed";
    });

    await vi.advanceTimersByTimeAsync(5_000);
    install.finish();
    expect(await step).toBe("installed");
    expect(call.sent().map(({ progress }) => progress)).toEqual([1, 2, 3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops notifying a client that cancelled the call", async () => {
    const call = toolCall("install-1");
    const install = fakeInstall();
    const step = stepProgress(call.request).step("pnpm install", install.run);

    await vi.advanceTimersByTimeAsync(5_000);
    call.cancel.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    install.finish();
    await step;
    expect(call.messages()).toEqual(["pnpm install: started", "pnpm install: running for 5s"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("create_project", () => {
  interface Created {
    created: boolean;
    directory: string;
    warnings: string[];
  }

  const uv = { name: "uv", check: ["uv", "--version"], install: ["uv", "sync"], url: "https://docs.astral.sh/uv/" };
  let createServer: McpServerFactory;
  let workspace: string;
  let pnpm: ReturnType<typeof fakeInstall>;
  let toolchain: ReturnType<typeof fakeInstall>;
  const connections: Array<{ close(): Promise<void> }> = [];

  /** Serves the tools to an in-memory client, which records what the server sends it. */
  async function connect() {
    const { serveStdio: serve } = await vi.importActual<typeof import("@modelcontextprotocol/server/stdio")>("@modelcontextprotocol/server/stdio");
    const [client, server] = InMemoryTransport.createLinkedPair();

    /** "progress" or "result", in the order they arrived. */
    const received: string[] = [];
    const progress: ProgressNotificationParams[] = [];
    const responses = new Map<number, (result: unknown) => void>();
    client.onmessage = (message: JSONRPCMessage) => {
      if ("method" in message && message.method === "notifications/progress") {
        received.push("progress");
        progress.push(message.params as unknown as ProgressNotificationParams);
      } else if ("id" in message && "result" in message) {
        received.push("result");
        responses.get(Number(message.id))?.(message.result);
      }
    };
    await client.start();
    connections.push(serve(createServer, { transport: server }));

    let nextId = 1;
    const request = (method: string, params: Record<string, unknown>) => {
      const id = nextId++;
      const response = new Promise<unknown>((resolve) => responses.set(id, resolve));
      void client.send({ jsonrpc: "2.0", id, method, params });
      return response;
    };
    await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    received.length = 0;

    return {
      received,
      progress,
      messages: () => progress.map(({ message }) => message),
      /** Calls create_project with dependency installation, and returns what the tool answered. */
      create: async (directory: string, progressToken?: string): Promise<Created> => {
        const result = (await request("tools/call", {
          name: "create_project",
          arguments: { directory, stacks: { framework: "vite", api: "fastapi" }, install_dependencies: true },
          ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
        })) as CallToolResult;
        expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
        const [content] = result.content;
        return JSON.parse(content?.type === "text" ? content.text : "") as Created;
      },
    };
  }

  beforeAll(async () => {
    await import("../src/mcp-server.js");
    createServer = vi.mocked(serveStdio).mock.calls[0]![0];
  });

  beforeEach(async () => {
    // The fixture's API as a Python one, which installs its own dependencies with uv.
    const files = appStarterFiles();
    const stack = "apps/api/clubedge.stack.json";
    files[stack] = JSON.stringify({ ...JSON.parse(files[stack]!), id: "fastapi", name: "FastAPI", toolchain: uv });
    starter = await temporaryDirectory();
    await writeFiles(starter, files);
    workspace = await realpath(await temporaryDirectory());
    vi.spyOn(process, "cwd").mockReturnValue(workspace);

    [pnpm, toolchain] = [fakeInstall(), fakeInstall()];
    vi.mocked(detectPnpm).mockResolvedValue({ pnpm: ["pnpm"] });
    vi.mocked(installDependencies).mockImplementation(() => pnpm.run());
    vi.mocked(commandSucceeds).mockResolvedValue(true);
    vi.mocked(run).mockImplementation(() => toolchain.run());
    // Only the progress timer and its clock are replaced: the tool reads and writes real files.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });

  afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()));
  });

  it("tells a client that sent a progress token about pnpm install and the toolchain while they run", async () => {
    const client = await connect();
    const created = client.create("my-app", "install-1");

    await pnpm.started;
    expect(client.messages()).toEqual(["pnpm install: started"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.messages().slice(1)).toEqual(["pnpm install: running for 5s", "pnpm install: running for 10s"]);
    pnpm.finish();

    await toolchain.started;
    await vi.advanceTimersByTimeAsync(6_000);
    toolchain.finish();

    expect(await created).toMatchObject({ created: true, directory: join(workspace, "my-app"), warnings: [] });
    expect(client.messages().slice(3)).toEqual([
      "pnpm install: finished in 10s",
      "uv sync in apps/api: started",
      "uv sync in apps/api: running for 5s",
      "uv sync in apps/api: finished in 6s",
    ]);
    expect(client.progress.map(({ progress }) => progress)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(client.progress.every(({ progressToken }) => progressToken === "install-1")).toBe(true);
    // Every notification reached the client before the result did.
    expect(client.received).toEqual([...Array<string>(7).fill("progress"), "result"]);
    expect(vi.mocked(run)).toHaveBeenCalledWith("uv", ["sync"], join(workspace, "my-app", "apps", "api"), expect.anything());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing to a client without a token, and answers the same with one", async () => {
    const client = await connect();
    const create = async (progressToken?: string) => {
      [pnpm, toolchain] = [fakeInstall(), fakeInstall()];
      const created = client.create("my-app", progressToken);
      await pnpm.started;
      await vi.advanceTimersByTimeAsync(10_000);
      pnpm.finish();
      await toolchain.started;
      toolchain.finish();
      return created;
    };

    const plain = await create();
    expect(plain).toMatchObject({ created: true, directory: join(workspace, "my-app"), warnings: [] });
    expect(client.received).toEqual(["result"]);

    // The destination must be empty to create the same project again.
    await rm(plain.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    expect(await create("install-1")).toEqual(plain);
    expect(client.progress).toHaveLength(6);
  });

  it("stops the notifications of a toolchain that fails, and still answers", async () => {
    const client = await connect();
    const created = client.create("my-app", "install-1");

    await pnpm.started;
    pnpm.finish();
    await toolchain.started;
    await vi.advanceTimersByTimeAsync(7_000);
    toolchain.fail(new Error("uv exited with code 1."));

    expect(await created).toMatchObject({ created: true, warnings: ["FastAPI dependencies did not install: uv exited with code 1."] });
    expect(client.messages().slice(-3)).toEqual([
      "uv sync in apps/api: started",
      "uv sync in apps/api: running for 5s",
      "uv sync in apps/api: failed after 7s",
    ]);
    expect(vi.getTimerCount()).toBe(0);

    const sent = client.progress.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.progress).toHaveLength(sent);
  });
});
