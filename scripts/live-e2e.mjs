#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMP_PREFIX = "pi-workflows-live-e2e-";
const PROCESS_TIMEOUT_MS = 10 * 60 * 1_000;
const RPC_TIMEOUT_MS = 30_000;
const RUNTIME_TIMEOUT_MS = 90_000;
const MODEL_TIMEOUT_MS = 10 * 60 * 1_000;
const DIAGNOSTIC_CHARS = 12_000;

export function parseArgs(argv) {
  const options = {
    keep: false,
    model: undefined,
    piEntry: path.join(
      REPO_ROOT,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
    profile: undefined,
    provider: undefined,
    runtimeOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--keep") options.keep = true;
    else if (argument === "--runtime-only") options.runtimeOnly = true;
    else if (["--model", "--pi-entry", "--profile", "--provider"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--model") options.model = value;
      else if (argument === "--pi-entry") options.piEntry = path.resolve(value);
      else if (argument === "--profile") options.profile = path.resolve(value);
      else options.provider = value;
    } else if (argument === "--help" || argument === "-h") {
      return { ...options, help: true };
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  const hasProvider = options.provider !== undefined;
  const hasModel = options.model !== undefined;
  if (hasProvider !== hasModel) {
    throw new Error("A real-model run requires both --provider and --model");
  }
  if (options.runtimeOnly && (hasProvider || options.profile !== undefined)) {
    throw new Error("--runtime-only cannot be combined with provider, model, or profile options");
  }
  if (!hasProvider) options.runtimeOnly = true;
  return options;
}

export function assertSafeTempRoot(root, temporaryDirectory = os.tmpdir()) {
  const resolvedRoot = path.resolve(root);
  const resolvedTemporaryDirectory = path.resolve(temporaryDirectory);
  if (
    path.dirname(resolvedRoot) !== resolvedTemporaryDirectory ||
    !path.basename(resolvedRoot).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`Refusing unsafe live E2E cleanup path: ${resolvedRoot}`);
  }
  return resolvedRoot;
}

export async function removeTemporaryRoot(root, temporaryDirectory = os.tmpdir()) {
  const safeRoot = assertSafeTempRoot(root, temporaryDirectory);
  const stat = await fs.lstat(safeRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing non-directory live E2E cleanup path: ${safeRoot}`);
  }
  await fs.rm(safeRoot, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
}

export async function withTemporaryRoot(operation, options = {}) {
  const temporaryDirectory = path.resolve(options.temporaryDirectory ?? os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryDirectory, TEMP_PREFIX));
  try {
    return await operation(root);
  } finally {
    if (options.keep === true) console.log(`Live E2E files kept at ${root}`);
    else await removeTemporaryRoot(root, temporaryDirectory);
  }
}

function usage() {
  return `Usage:
  npm run test:e2e:live -- --runtime-only
  npm run test:e2e:live -- --provider PROVIDER --model MODEL [--profile ABSOLUTE_PATH]

Options:
  --runtime-only       Run the installed package, widget, host, pause/resume, and piw checks without a model call.
  --provider NAME      Exact built-in Pi provider for the optional real-model phase.
  --model ID           Exact model id for the optional real-model phase.
  --profile PATH       Dedicated Pi agent directory that already contains subscription authentication.
  --pi-entry PATH      Base Pi cli.js entry point. Defaults to the repository-pinned Pi dependency.
  --keep               Keep the guarded temporary root for diagnosis.
`;
}

function stage(message) {
  process.stdout.write(`[live-e2e] ${message}\n`);
}

function tail(text, length = DIAGNOSTIC_CHARS) {
  return text.length <= length ? text : text.slice(-length);
}

function cleanEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter((entry) => typeof entry[1] === "string"),
  );
}

function sanitize(text, context) {
  return text
    .replaceAll(context.root, "<live-e2e-root>")
    .replaceAll(context.profile ?? "\u0000", "<profile>");
}

async function runProcess(executable, args, options) {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  options.children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  let timedOut = false;
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    options.children.delete(child);
  });

  if (timedOut || result.code !== 0) {
    const reason = timedOut
      ? `timed out after ${options.timeoutMs ?? PROCESS_TIMEOUT_MS} ms`
      : `exited with code ${String(result.code)} and signal ${String(result.signal)}`;
    throw new Error(
      `${executable} ${args.join(" ")} ${reason}\nstdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`,
    );
  }
  return { stdout, stderr };
}

class RpcSession {
  constructor(child, context) {
    this.child = child;
    this.context = context;
    this.events = [];
    this.pending = new Map();
    this.stderr = "";
    this.stdoutBuffer = "";
    this.parseError = undefined;
    this.exited = false;
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    child.once("close", (code, signal) => {
      this.exited = true;
      const error = new Error(
        `Pi RPC exited with code ${String(code)} and signal ${String(signal)}\n${this.diagnostic()}`,
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.parseError = new Error(`Pi RPC emitted invalid JSONL: ${String(error)}`);
        continue;
      }
      if (message.type === "response" && typeof message.id === "string") {
        const pending = this.pending.get(message.id);
        if (pending !== undefined) {
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.success === true) pending.resolve(message.data);
          else pending.reject(new Error(message.error ?? `Pi RPC ${message.command} failed`));
        }
      } else {
        this.events.push(message);
      }
    }
  }

  async request(type, fields = {}, timeoutMs = RPC_TIMEOUT_MS) {
    if (this.exited) throw new Error(`Pi RPC is not running\n${this.diagnostic()}`);
    if (this.parseError !== undefined) throw this.parseError;
    const id = `live-e2e-${randomUUID()}`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${type} timed out\n${this.diagnostic()}`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return await response;
  }

  diagnostic() {
    const eventTail = this.events
      .slice(-20)
      .map((event) => JSON.stringify(event))
      .join("\n");
    return sanitize(
      `Pi stderr tail:\n${tail(this.stderr)}\nPi event tail:\n${tail(eventTail)}`,
      this.context,
    );
  }

  assertNoExtensionError() {
    const failure = this.events.find((event) => event.type === "extension_error");
    if (failure !== undefined) {
      throw new Error(
        `Pi reported an extension error: ${JSON.stringify(failure)}\n${this.diagnostic()}`,
      );
    }
    if (this.parseError !== undefined) throw this.parseError;
  }

  async stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Pi RPC stopped"));
    }
    this.pending.clear();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => this.child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await new Promise((resolve) => this.child.once("close", resolve));
    }
  }
}

async function waitFor(description, check, options) {
  const deadline = Date.now() + options.timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    options.rpc?.assertNoExtensionError();
    try {
      const result = await check();
      if (result !== false && result !== undefined && result !== null) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 100));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(
    `Timed out waiting for ${description}${detail}\n${options.rpc?.diagnostic() ?? ""}`,
  );
}

function requireObject(value, description) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function requireAccepted(response, description) {
  const value = requireObject(response, description);
  if (value.outcome !== "accepted" && value.outcome !== "adopted") {
    throw new Error(`${description} was not accepted: ${JSON.stringify(value)}`);
  }
  return value;
}

function extensionUiEvents(rpc, start = 0) {
  return rpc.events.slice(start).filter((event) => event.type === "extension_ui_request");
}

function hasWorkflowUiState(rpc, workflowName, status, start = 0) {
  const events = extensionUiEvents(rpc, start);
  const statusSeen = events.some(
    (event) =>
      event.method === "setStatus" &&
      event.statusKey === "pi-workflows" &&
      event.statusText === `${workflowName} [${status}]`,
  );
  const widgetSeen = events.some(
    (event) =>
      event.method === "setWidget" &&
      event.widgetKey === "pi-workflows" &&
      Array.isArray(event.widgetLines) &&
      event.widgetLines.join("\n").includes(workflowName) &&
      event.widgetLines.join("\n").toLowerCase().includes(status),
  );
  return statusSeen && widgetSeen;
}

function hasWorkflowUiClear(rpc, start = 0) {
  const events = extensionUiEvents(rpc, start);
  const statusCleared = events.some(
    (event) =>
      event.method === "setStatus" &&
      event.statusKey === "pi-workflows" &&
      !("statusText" in event),
  );
  const widgetCleared = events.some(
    (event) =>
      event.method === "setWidget" &&
      event.widgetKey === "pi-workflows" &&
      !("widgetLines" in event),
  );
  return statusCleared && widgetCleared;
}

function assertExactModel(state, provider, model, expectedApi) {
  const selected = requireObject(requireObject(state, "Pi state").model, "Pi selected model");
  if (selected.provider !== provider || selected.id !== model || selected.api !== expectedApi) {
    throw new Error(
      `Pi model fallback detected: requested ${provider}/${model} (${expectedApi}), observed ${String(selected.provider)}/${String(selected.id)} (${String(selected.api)})`,
    );
  }
}

function validateProfile(profile) {
  if (profile === undefined) return Promise.resolve();
  return fs.stat(profile).then(async (stat) => {
    if (!stat.isDirectory()) throw new Error(`Pi test profile is not a directory: ${profile}`);
    const modelsPath = path.join(profile, "models.json");
    try {
      await fs.access(modelsPath);
      throw new Error(`The dedicated test profile must not contain custom models: ${modelsPath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    let settings;
    try {
      settings = JSON.parse(await fs.readFile(path.join(profile, "settings.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const record = requireObject(settings, "Pi test profile settings");
    for (const key of ["packages", "extensions", "skills", "promptTemplates", "themes"]) {
      const value = record[key];
      if (Array.isArray(value) && value.length > 0) {
        throw new Error(`The dedicated Pi test profile has unrelated ${key}`);
      }
    }
  });
}

async function findRun(client, workflowName) {
  return await waitFor(
    `host run ${workflowName}`,
    async () => {
      const response = requireAccepted(
        await client.request({ operation: "run.list", payload: { limit: 20 } }),
        "run list",
      );
      if (!Array.isArray(response.receipt)) return false;
      return response.receipt.find((run) => run.workflowName === workflowName) ?? false;
    },
    { timeoutMs: 30_000 },
  );
}

async function waitForRunDisplay(client, runId, status, timeoutMs, rpc) {
  return await waitFor(
    `workflow ${runId} to become ${status}`,
    async () => {
      const view = await client.getRun(runId);
      return view?.display?.status === status ? view : false;
    },
    { rpc, timeoutMs },
  );
}

function assertOneFrame(output, workflowName, status) {
  const normalized = output.toLowerCase();
  if (!output.includes(workflowName) || !normalized.includes(status)) {
    throw new Error(
      `piw one-frame output did not show ${workflowName} as ${status}:\n${tail(output)}`,
    );
  }
}

async function installCandidate(context) {
  stage("packing the npm package");
  await fs.mkdir(context.packs, { recursive: true });
  const packed = await runProcess(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--silent", "--pack-destination", context.packs],
    context.processOptions(REPO_ROOT),
  );
  const archiveName = packed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .at(-1);
  if (archiveName === undefined) throw new Error(`npm pack returned no archive: ${packed.stdout}`);
  const archivePath = path.join(context.packs, path.basename(archiveName));

  stage("installing the packed package into an isolated consumer");
  await fs.mkdir(context.consumer, { recursive: true });
  await fs.writeFile(
    path.join(context.consumer, "package.json"),
    `${JSON.stringify({ name: "pi-workflows-live-e2e-consumer", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  await runProcess(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", archivePath],
    context.processOptions(context.consumer),
  );
  const candidate = path.join(context.consumer, "node_modules", "@osolmaz", "pi-workflows");
  await fs.access(path.join(candidate, "dist", "extension", "index.js"));
  await fs.access(path.join(candidate, "dist", "client", "index.js"));

  stage("installing the candidate package through base Pi");
  await runProcess(
    process.execPath,
    [context.options.piEntry, "install", candidate, "--local", "--approve"],
    context.processOptions(context.project),
  );
  return candidate;
}

async function buildPiw(context) {
  stage("installing the piw candidate");
  await runProcess(
    "cargo",
    [
      "install",
      "--path",
      path.join(REPO_ROOT, "tui"),
      "--root",
      context.piwRoot,
      "--locked",
      "--force",
    ],
    context.processOptions(REPO_ROOT, { CARGO_TARGET_DIR: context.cargoTarget }),
  );
  const binary = path.join(
    context.piwRoot,
    "bin",
    process.platform === "win32" ? "piw.exe" : "piw",
  );
  await fs.access(binary);
  return binary;
}

async function startPi(context) {
  const args = [
    context.options.piEntry,
    "--mode",
    "rpc",
    "--session-id",
    randomUUID(),
    "--session-dir",
    context.sessions,
    "--name",
    "Pi Workflows installed live E2E",
    "--no-skills",
    "--no-themes",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-builtin-tools",
    "--offline",
    "--approve",
  ];
  if (!context.options.runtimeOnly) {
    args.push("--provider", context.options.provider, "--model", context.options.model);
  }
  const child = spawn(process.execPath, args, {
    cwd: context.project,
    env: context.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  context.children.add(child);
  const rpc = new RpcSession(child, context);
  await waitFor("base Pi RPC startup", async () => await rpc.request("get_state"), {
    rpc,
    timeoutMs: 30_000,
  });
  return rpc;
}

async function assertPackageIsolation(rpc, candidate) {
  const data = requireObject(await rpc.request("get_commands"), "Pi commands response");
  if (!Array.isArray(data.commands)) throw new Error("Pi commands response has no command list");
  const commandPath = (command) => command.path ?? command.sourceInfo?.path;
  for (const required of ["workflow", "controller", "piw"]) {
    const command = data.commands.find((item) => item.name === required);
    if (command === undefined || command.source !== "extension") {
      throw new Error(`Installed candidate did not register /${required}`);
    }
    const sourcePath = commandPath(command);
    if (
      typeof sourcePath !== "string" ||
      !path.resolve(sourcePath).startsWith(`${candidate}${path.sep}`)
    ) {
      throw new Error(
        `/${required} did not load from the installed candidate: ${JSON.stringify(command)}`,
      );
    }
  }
  const unrelated = data.commands.filter((command) => {
    if (command.source !== "extension") return true;
    const sourcePath = commandPath(command);
    if (typeof sourcePath === "string" && sourcePath.startsWith("<inline:")) return false;
    return (
      typeof sourcePath !== "string" ||
      !path.resolve(sourcePath).startsWith(`${candidate}${path.sep}`)
    );
  });
  if (unrelated.length > 0) {
    throw new Error(`Base Pi loaded unrelated resources: ${JSON.stringify(unrelated)}`);
  }
}

async function runRuntimeWorkflow(context, rpc, client, piwBinary) {
  const workflowName = "live-runtime-e2e";
  stage("running the model-free workflow through Pi");
  const runningEvents = rpc.events.length;
  await rpc.request("prompt", { message: `/workflow ${workflowName}` });
  await waitFor(
    "the running Pi workflow widget and status",
    () => hasWorkflowUiState(rpc, workflowName, "running", runningEvents),
    { rpc, timeoutMs: 30_000 },
  );
  const run = await findRun(client, workflowName);
  const runId = run.runId;

  const pauseEvents = rpc.events.length;
  await rpc.request("prompt", { message: "/workflow pause" });
  await waitFor(
    "the paused Pi workflow widget and status",
    () => hasWorkflowUiState(rpc, workflowName, "paused", pauseEvents),
    { rpc, timeoutMs: 30_000 },
  );
  await waitForRunDisplay(client, runId, "paused", 30_000, rpc);
  await waitFor(
    "a parked run with no active worker",
    async () => {
      const response = requireAccepted(
        await client.request({ operation: "host.status" }),
        "host status",
      );
      const receipt = requireObject(response.receipt, "host status receipt");
      return receipt.activeWorkers === 0 && receipt.parkedRuns === 1 ? receipt : false;
    },
    { rpc, timeoutMs: 30_000 },
  );

  const pausedFrame = await runProcess(
    piwBinary,
    [runId, "--once"],
    context.processOptions(context.project),
  );
  assertOneFrame(pausedFrame.stdout, workflowName, "paused");

  const resumeEvents = rpc.events.length;
  await rpc.request("prompt", { message: "/workflow resume" });
  await waitFor(
    "the resumed Pi workflow widget and status",
    () => hasWorkflowUiState(rpc, workflowName, "running", resumeEvents),
    { rpc, timeoutMs: 30_000 },
  );
  const completed = await waitForRunDisplay(client, runId, "completed", RUNTIME_TIMEOUT_MS, rpc);
  const state = requireObject(completed.state, "runtime workflow state");
  if (JSON.stringify(state.finalOutput) !== JSON.stringify({ smoke: "runtime-passed" })) {
    throw new Error(
      `Runtime workflow returned the wrong output: ${JSON.stringify(state.finalOutput)}`,
    );
  }
  await waitFor(
    "Pi to clear the workflow widget and status",
    () => hasWorkflowUiClear(rpc, resumeEvents),
    { rpc, timeoutMs: 30_000 },
  );

  const completedFrame = await runProcess(
    piwBinary,
    [runId, "--once"],
    context.processOptions(context.project),
  );
  assertOneFrame(completedFrame.stdout, workflowName, "completed");
  rpc.assertNoExtensionError();
  return runId;
}

async function preflightModel(context, rpc) {
  stage(`checking authentication for ${context.options.provider}/${context.options.model}`);
  const auth = await runProcess(
    process.execPath,
    [
      context.options.piEntry,
      "auth",
      "check",
      "--provider",
      context.options.provider,
      "--model",
      context.options.model,
      "--json",
    ],
    context.processOptions(context.project),
  );
  const authStatus = requireObject(JSON.parse(auth.stdout), "Pi authentication status");
  if (authStatus.status !== "ready") {
    throw new Error(`Pi authentication is not ready: ${JSON.stringify(authStatus)}`);
  }

  const available = requireObject(await rpc.request("get_available_models"), "Pi available models");
  if (!Array.isArray(available.models)) throw new Error("Pi returned no available model list");
  const model = available.models.find(
    (candidate) =>
      candidate.provider === context.options.provider && candidate.id === context.options.model,
  );
  if (model === undefined || typeof model.api !== "string") {
    throw new Error(
      `Pi does not expose the exact built-in model ${context.options.provider}/${context.options.model}`,
    );
  }
  if (
    context.options.provider === "openai-codex" &&
    context.options.model === "gpt-5.6-luna" &&
    model.api !== "openai-codex-responses"
  ) {
    throw new Error(`openai-codex/gpt-5.6-luna resolved to unexpected API ${model.api}`);
  }
  if (
    context.options.provider === "openai" &&
    context.options.model === "gpt-5.6-luna" &&
    model.api !== "openai-responses"
  ) {
    throw new Error(`openai/gpt-5.6-luna resolved to unexpected API ${model.api}`);
  }
  const state = await rpc.request("get_state");
  assertExactModel(state, context.options.provider, context.options.model, model.api);
  return model.api;
}

async function runModelWorkflow(context, rpc, client, api) {
  const workflowName = "live-model-e2e";
  stage(
    `running the real-model workflow through ${context.options.provider}/${context.options.model}`,
  );
  await rpc.request("prompt", { message: `/workflow ${workflowName}` });
  const run = await findRun(client, workflowName);
  const completed = await waitForRunDisplay(client, run.runId, "completed", MODEL_TIMEOUT_MS, rpc);
  const state = requireObject(completed.state, "model workflow state");
  const expected = { smoke: "model-passed", nonce: "pi-workflows-live-e2e" };
  if (JSON.stringify(state.finalOutput) !== JSON.stringify(expected)) {
    throw new Error(
      `Model workflow returned the wrong output: ${JSON.stringify(state.finalOutput)}`,
    );
  }
  if (!Array.isArray(state.steps) || state.steps.length !== 1) {
    throw new Error(`Model workflow recorded ${String(state.steps?.length)} steps instead of one`);
  }
  const step = requireObject(state.steps[0], "model workflow step");
  if (typeof step.attemptId !== "string" || step.outcome !== "ok") {
    throw new Error(`Model workflow step was not accepted: ${JSON.stringify(step)}`);
  }

  const entriesData = requireObject(await rpc.request("get_entries"), "Pi entries response");
  if (!Array.isArray(entriesData.entries)) throw new Error("Pi returned no session entries");
  const deliveries = entriesData.entries.filter(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-workflows-agent-step" &&
      entry.details?.contract?.runId === run.runId,
  );
  if (deliveries.length !== 1) {
    throw new Error(`Expected one durable workflow step delivery, observed ${deliveries.length}`);
  }
  const details = requireObject(deliveries[0].details, "workflow step delivery");
  if (typeof details.requestId !== "string" || details.contract?.attemptId !== step.attemptId) {
    throw new Error(
      `Workflow delivery does not match the accepted attempt: ${JSON.stringify(details)}`,
    );
  }
  assertExactModel(
    await rpc.request("get_state"),
    context.options.provider,
    context.options.model,
    api,
  );
  rpc.assertNoExtensionError();
  return run.runId;
}

async function waitForEndpointClosed(endpoint) {
  await waitFor(
    "the workflow host endpoint to close",
    () =>
      new Promise((resolve) => {
        const socket = net.createConnection(endpoint);
        socket.once("connect", () => {
          socket.destroy();
          resolve(false);
        });
        socket.once("error", () => resolve(true));
      }),
    { timeoutMs: 10_000 },
  );
}

async function stopChildren(children) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
}

async function execute(root, options) {
  assertSafeTempRoot(root);
  const profile = options.profile ?? path.join(root, "agent");
  await validateProfile(options.profile);
  const context = {
    cargoTarget: path.join(root, "cargo-target"),
    children: new Set(),
    consumer: path.join(root, "consumer"),
    home: path.join(root, "home"),
    npmCache: path.join(root, "npm-cache"),
    options,
    packs: path.join(root, "packs"),
    piwRoot: path.join(root, "piw"),
    profile,
    project: path.join(root, "project"),
    root,
    sessions: path.join(root, "sessions"),
    temporary: path.join(root, "tmp"),
    xdgCache: path.join(root, "xdg-cache"),
    xdgConfig: path.join(root, "xdg-config"),
    xdgData: path.join(root, "xdg-data"),
  };
  await Promise.all(
    [
      context.home,
      context.profile,
      context.project,
      context.sessions,
      context.temporary,
      context.xdgCache,
      context.xdgConfig,
      context.xdgData,
      path.join(context.project, ".pi", "workflows"),
    ].map(async (directory) => await fs.mkdir(directory, { recursive: true })),
  );
  const operatorHome = os.homedir();
  context.env = cleanEnvironment({
    ...process.env,
    CARGO_HOME: process.env.CARGO_HOME ?? path.join(operatorHome, ".cargo"),
    CI: "1",
    HOME: context.home,
    NO_COLOR: "1",
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: context.profile,
    PI_CODING_AGENT_SESSION_DIR: context.sessions,
    PI_OFFLINE: "1",
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(operatorHome, ".rustup"),
    TMPDIR: context.temporary,
    XDG_CACHE_HOME: context.xdgCache,
    XDG_CONFIG_HOME: context.xdgConfig,
    XDG_DATA_HOME: context.xdgData,
    npm_config_cache: context.npmCache,
  });
  context.processOptions = (cwd, extraEnvironment = {}) => ({
    children: context.children,
    cwd,
    env: cleanEnvironment({ ...context.env, ...extraEnvironment }),
    timeoutMs: PROCESS_TIMEOUT_MS,
  });

  await Promise.all([
    fs.copyFile(
      path.join(REPO_ROOT, "test", "fixtures", "live-e2e", "runtime.workflow.ts"),
      path.join(context.project, ".pi", "workflows", "live-runtime-e2e.workflow.ts"),
    ),
    fs.copyFile(
      path.join(REPO_ROOT, "test", "fixtures", "live-e2e", "model.workflow.ts"),
      path.join(context.project, ".pi", "workflows", "live-model-e2e.workflow.ts"),
    ),
  ]);

  let rpc;
  let client;
  try {
    await fs.access(options.piEntry);
    const candidate = await installCandidate(context);
    const piwBinary = await buildPiw(context);
    context.env.PATH = `${path.join(context.consumer, "node_modules", ".bin")}${path.delimiter}${path.dirname(piwBinary)}${path.delimiter}${context.env.PATH}`;

    const packageJson = JSON.parse(await fs.readFile(path.join(candidate, "package.json"), "utf8"));
    const piVersion = (
      await runProcess(
        process.execPath,
        [options.piEntry, "--version"],
        context.processOptions(context.project),
      )
    ).stdout.trim();
    const rustVersion = (
      await runProcess("rustc", ["--version"], context.processOptions(context.project))
    ).stdout.trim();

    rpc = await startPi(context);
    await assertPackageIsolation(rpc, candidate);
    const clientModule = await import(
      `${pathToFileURL(path.join(candidate, "dist", "client", "index.js")).href}?live=${Date.now()}`
    );
    const databasePath = path.join(context.home, ".pi", "agent", "workflows", "state.sqlite");
    client = new clientModule.WorkflowClient({
      clientId: `live-e2e-${randomUUID()}`,
      databasePath,
      env: context.env,
    });
    await client.ensureAvailable();

    const runtimeRunId = await runRuntimeWorkflow(context, rpc, client, piwBinary);
    let modelRunId;
    let api;
    if (!options.runtimeOnly) {
      api = await preflightModel(context, rpc);
      modelRunId = await runModelWorkflow(context, rpc, client, api);
    }

    const hostStatus = requireAccepted(
      await client.request({ operation: "host.status" }),
      "final host status",
    );
    const hostReceipt = requireObject(hostStatus.receipt, "final host status receipt");
    if (hostReceipt.lifecycleContradictions !== 0 || hostReceipt.ambiguousEffects !== 0) {
      throw new Error(`Host ended with unsafe state: ${JSON.stringify(hostReceipt)}`);
    }
    rpc.assertNoExtensionError();
    process.stdout.write(
      `${JSON.stringify({
        api: api ?? null,
        mode: options.runtimeOnly ? "runtime-only" : "real-model",
        model: options.model ?? null,
        modelRunId: modelRunId ?? null,
        packageVersion: packageJson.version,
        piVersion,
        provider: options.provider ?? null,
        result: "passed",
        runtimeRunId,
        rustVersion,
      })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw new Error(sanitize(message, context));
  } finally {
    if (rpc !== undefined) await rpc.stop();
    if (client !== undefined) {
      const endpoint = client.endpoint;
      try {
        await client.request({ operation: "host.stop" });
      } catch {
        // The host is already stopped or never became available.
      }
      await client.close();
      await waitForEndpointClosed(endpoint);
    }
    await stopChildren(context.children);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help === true) {
    process.stdout.write(usage());
    return;
  }
  await withTemporaryRoot(async (root) => await execute(root, options), { keep: options.keep });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
