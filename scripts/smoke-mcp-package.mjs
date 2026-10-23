#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const entrypoint = join(packageRoot, "bin", "mcp.mjs");
const skillPath = join(packageRoot, "skills", "clubedge-starter", "SKILL.md");
const workspace = await mkdtemp(join(tmpdir(), "clubedge-mcp-smoke-"));
const server = spawn(process.execPath, [entrypoint], {
  cwd: workspace,
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuffer = "";
let stderr = "";
let didExit = false;
let nextId = 1;
const pending = new Map();

server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  while (stdoutBuffer.includes("\n")) {
    const newline = stdoutBuffer.indexOf("\n");
    const line = stdoutBuffer.slice(0, newline);
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      rejectPending(new Error(`MCP stdout contained non-JSON output: ${line}`, { cause: error }));
      continue;
    }
    const request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timeout);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`MCP ${request.method} failed: ${JSON.stringify(message.error)}`));
      else request.resolve(message.result);
    }
  }
});
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => (stderr += chunk));
server.stdin.on("error", (error) => rejectPending(error));
server.once("error", (error) => rejectPending(error));
server.once("exit", (code, signal) => {
  didExit = true;
  if (pending.size > 0) rejectPending(new Error(`MCP server exited (${signal ?? code}). ${stderr}`));
});

function rejectPending(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(error);
  }
  pending.clear();
}

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolveRequest, rejectRequest) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`Timed out waiting for MCP ${method}. ${stderr}`));
    }, 30_000);
    pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timeout });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params = {}) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function callTool(name, args = {}) {
  return await request("tools/call", { name, arguments: args });
}

function toolText(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, `MCP tool returned no text content: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

try {
  await readFile(skillPath, "utf8");
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "clubedge-package-smoke", version: "1.0.0" },
  });
  assert.ok(initialized.serverInfo?.name, "MCP initialize did not return serverInfo");
  notify("notifications/initialized");

  const listed = await request("tools/list");
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of ["get_starter_capabilities", "validate_project_config", "plan_project", "create_project"]) {
    assert.ok(tools.has(name), `MCP server did not register ${name}`);
  }
  assert.equal(tools.get("get_starter_capabilities").annotations?.readOnlyHint, true);
  assert.equal(tools.get("validate_project_config").annotations?.readOnlyHint, true);
  assert.equal(tools.get("plan_project").annotations?.readOnlyHint, true);

  const capabilities = toolText(await callTool("get_starter_capabilities"));
  assert.ok(capabilities.starter?.ref, "Capabilities omitted the pinned Starter ref");
  assert.ok(capabilities.slots?.length, "Capabilities omitted stack slots");
  assert.ok(Array.isArray(capabilities.modules), "Capabilities omitted modules");

  const validation = toolText(await callTool("validate_project_config"));
  assert.equal(validation.valid, true, JSON.stringify(validation));
  const invalidValidation = toolText(await callTool("validate_project_config", { stacks: { framework: "not-a-stack" } }));
  assert.equal(invalidValidation.valid, false, JSON.stringify(invalidValidation));

  const plan = toolText(await callTool("plan_project", { directory: "planned" }));
  assert.equal(plan.valid, true, JSON.stringify(plan));
  assert.equal(plan.directory, join(workspace, "planned"));
  assert.equal(plan.destinationMustBeEmpty, true);
  assert.ok(plan.fileCount > 0, "Project plan omitted the generated file count");
  assert.ok(plan.actions.some((action) => action.startsWith("Create ")));
  await assert.rejects(access(join(workspace, "planned")), "Planning unexpectedly created its destination");

  const invalidPlan = toolText(await callTool("plan_project", {
    directory: "invalid-plan",
    stacks: { framework: "not-a-stack" },
  }));
  assert.equal(invalidPlan.valid, false, JSON.stringify(invalidPlan));
  await assert.rejects(access(join(workspace, "invalid-plan")), "Invalid planning unexpectedly created its destination");

  const outsidePlan = toolText(await callTool("plan_project", { directory: "../outside-plan" }));
  assert.equal(outsidePlan.valid, false, JSON.stringify(outsidePlan));
  await assert.rejects(access(resolve(workspace, "..", "outside-plan")));

  const outsideName = `clubedge-mcp-outside-${Date.now()}`;
  const outside = await callTool("create_project", { directory: `../${outsideName}` });
  assert.equal(outside.isError, true, `MCP accepted an outside path: ${JSON.stringify(outside)}`);
  await assert.rejects(access(resolve(workspace, "..", outsideName)));

  const occupied = join(workspace, "occupied");
  await mkdir(occupied);
  const marker = join(occupied, "user-data.txt");
  await writeFile(marker, "keep this file\n");
  const refused = await callTool("create_project", { directory: "occupied" });
  assert.equal(refused.isError, true, `MCP accepted a non-empty destination: ${JSON.stringify(refused)}`);
  assert.equal(await readFile(marker, "utf8"), "keep this file\n");

  const created = toolText(await callTool("create_project", { directory: "generated", initialize_git: true }));
  assert.equal(created.created, true, JSON.stringify(created));
  assert.equal(created.directory, join(workspace, "generated"));
  const generatedPackage = JSON.parse(await readFile(join(workspace, "generated", "package.json"), "utf8"));
  assert.ok(generatedPackage.name, "Scaffolded package has no name");
  await readFile(join(workspace, "generated", ".git", "HEAD"), "utf8");

  console.log("MCP package smoke passed: initialize, tools, capabilities, validation, planning, safe creation, path guard, overwrite refusal, bundled skill.");
} catch (error) {
  console.error(error);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  server.stdin.end();
  if (server.pid && server.exitCode === null && !didExit) {
    const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
    const killTimer = setTimeout(() => server.kill(), 2_000);
    await exited;
    clearTimeout(killTimer);
  }
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
