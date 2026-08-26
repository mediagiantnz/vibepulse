#!/usr/bin/env node

import {
  chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";


const RELAY_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(RELAY_DIR, "..", "..");
const WORKER_NAME = "vibepulse-relay";
const COMPATIBILITY_DATE = "2026-08-22";
const COMPATIBILITY_FLAGS = ["nodejs_compat"];
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
const DEFAULT_SIGNAL_GRACE_MS = 5_000;
const ZERO_KV_ID = "0".repeat(32);
const REAL_KV_ID_PATTERN = /^[0-9a-f]{32}$/;
const STAGE_MAINS = new Set(["bootstrap.js", "worker.js"]);
const TEST_CONFIGS = [
  resolve(RELAY_DIR, "wrangler.test.jsonc"),
  resolve(RELAY_DIR, "wrangler.worker.test.jsonc"),
];

function guardError(message) {
  return new Error(`deploy guard: ${message}`);
}

function isWithinRepository(path) {
  const child = relative(REPOSITORY_ROOT, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function pinnedWrangler() {
  const executable = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  return resolve(RELAY_DIR, "node_modules", ".bin", executable);
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function childExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", () => reject(guardError("Wrangler could not start")));
    child.once("exit", (status, signal) => resolveExit({ status, signal }));
  });
}

function waitForExitWithin(exitPromise, timeoutMs) {
  return new Promise((resolveWait, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolveWait(undefined);
    }, timeoutMs);
    exitPromise.then((result) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolveWait(result);
    }, (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(error);
    });
  });
}

function installSignalRelay() {
  let activeChild;
  let receivedSignal;
  let resolveSignal;
  const signalPromise = new Promise((resolveReceived) => {
    resolveSignal = resolveReceived;
  });
  const forward = (signal) => {
    if (receivedSignal === undefined) {
      receivedSignal = signal;
      resolveSignal(signal);
    }
    if (activeChild && activeChild.exitCode === null &&
        activeChild.signalCode === null) {
      try {
        activeChild.kill(signal);
      } catch {
        // The exit observer below remains authoritative if the child raced us.
      }
    }
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    attach(child) {
      activeChild = child;
      if (receivedSignal !== undefined) forward(receivedSignal);
    },
    detach(child) {
      if (activeChild === child) activeChild = undefined;
    },
    dispose() {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    },
    get signal() { return receivedSignal; },
    signalPromise,
  };
}

function signalResult(signal) {
  return { signal, exitCode: SIGNAL_EXIT_CODES[signal] };
}

async function invokeWrangler(args, dependencies = {}, signalRelay) {
  const {
    spawn = nodeSpawn,
    signalGraceMs = DEFAULT_SIGNAL_GRACE_MS,
    signalKillGraceMs = DEFAULT_SIGNAL_GRACE_MS,
  } = dependencies;
  let child;
  try {
    child = spawn(pinnedWrangler(), args, {
      cwd: RELAY_DIR,
      stdio: "inherit",
    });
  } catch {
    throw guardError("Wrangler could not start");
  }
  const exitPromise = childExit(child);
  signalRelay.attach(child);
  try {
    const first = await Promise.race([
      exitPromise.then((result) => ({ kind: "exit", result })),
      signalRelay.signalPromise.then((signal) => ({ kind: "signal", signal })),
    ]);
    const receivedSignal = signalRelay.signal;
    if (first.kind === "signal" || receivedSignal !== undefined) {
      const signal = receivedSignal ?? first.signal;
      let exit = first.kind === "exit" ? first.result
                                      : await waitForExitWithin(
                                        exitPromise, signalGraceMs,
                                      );
      if (exit === undefined) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The bounded exit wait below produces the deployment error.
        }
        exit = await waitForExitWithin(exitPromise, signalKillGraceMs);
      }
      if (exit === undefined)
        throw guardError("Wrangler did not exit after termination");
      return signalResult(signal);
    }
    if (first.result.status !== 0) {
      if (first.result.signal)
        throw guardError(`Wrangler exited from ${first.result.signal}`);
      throw guardError(
        `Wrangler exited with status ${String(first.result.status)}`,
      );
    }
    return {};
  } finally {
    signalRelay.detach(child);
  }
}

export function validateProductionConfig(config, {
  configPath, expectedKvId, expectedMain,
}) {
  if (typeof configPath !== "string" || !isAbsolute(configPath) ||
      resolve(configPath) !== configPath ||
      isWithinRepository(resolve(configPath)) ||
      !configPath.endsWith(".json"))
    throw guardError("production config must be an absolute private .json file");
  if (!REAL_KV_ID_PATTERN.test(expectedKvId) ||
      expectedKvId === ZERO_KV_ID)
    throw guardError("expected KV ID must be a nonzero 32-character hex ID");
  if (!STAGE_MAINS.has(expectedMain))
    throw guardError("expected main must be bootstrap.js or worker.js");
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw guardError("production config must be a JSON object");
  if (!hasExactKeys(config, [
    "name", "main", "compatibility_date", "compatibility_flags",
    "observability", "durable_objects", "exports", "kv_namespaces",
    "secrets",
  ]))
    throw guardError("production config has an unexpected top-level shape");
  if (config.name !== WORKER_NAME)
    throw guardError("wrong Worker name");
  if (config.main !== expectedMain)
    throw guardError("wrong stage entrypoint");
  if (config.compatibility_date !== COMPATIBILITY_DATE)
    throw guardError(`compatibility_date must be ${COMPATIBILITY_DATE}`);
  if (!Array.isArray(config.compatibility_flags) ||
      config.compatibility_flags.length !== COMPATIBILITY_FLAGS.length ||
      config.compatibility_flags[0] !== COMPATIBILITY_FLAGS[0])
    throw guardError("compatibility_flags must contain only nodejs_compat");
  // Workers Logs invocation logs keep the request URL for seven days, and
  // for this Worker the URL is the credential. Only the app's own
  // metadata-only console output may be collected.
  if (!hasExactKeys(config.observability, ["enabled", "logs"]) ||
      config.observability.enabled !== true ||
      !hasExactKeys(config.observability.logs, ["invocation_logs"]) ||
      config.observability.logs.invocation_logs !== false)
    throw guardError(
      "observability must be enabled with invocation_logs disabled exactly",
    );

  const kvBindings = config.kv_namespaces;
  if (!Array.isArray(kvBindings) || kvBindings.length !== 1 ||
      !hasExactKeys(kvBindings[0], ["binding", "id"]) ||
      kvBindings[0].binding !== "VIBEPULSE" ||
      kvBindings[0].id !== expectedKvId || kvBindings[0].id === ZERO_KV_ID)
    throw guardError("VIBEPULSE must match the expected real KV namespace");

  if (!hasExactKeys(config.durable_objects, ["bindings"]))
    throw guardError("durable_objects must contain only bindings");
  const configuredObjectBindings = config.durable_objects.bindings;
  if (!Array.isArray(configuredObjectBindings) ||
      configuredObjectBindings.length !== 1 ||
      !hasExactKeys(configuredObjectBindings[0], ["name", "class_name"]) ||
      configuredObjectBindings[0].name !== "NUMBERS_MAILBOX" ||
      configuredObjectBindings[0].class_name !== "NumbersMailbox")
    throw guardError("NUMBERS_MAILBOX must bind NumbersMailbox");
  if (!hasExactKeys(config.exports, ["NumbersMailbox"]))
    throw guardError("NumbersMailbox must be the only lifecycle export");
  const mailboxExport = config.exports?.NumbersMailbox;
  if (!hasExactKeys(mailboxExport, ["type", "storage", "state"]) ||
      mailboxExport?.type !== "durable-object" ||
      mailboxExport?.storage !== "sqlite" ||
      mailboxExport?.state !== "created")
    throw guardError("NumbersMailbox must be a SQLite Durable Object export");
  if (!hasExactKeys(config.secrets, ["required"]) ||
      !Array.isArray(config.secrets.required) ||
      config.secrets.required.length !== 1 ||
      config.secrets.required[0] !== "RELAY_SECRET")
    throw guardError("RELAY_SECRET must be declared as required");

  return {
    name: WORKER_NAME,
    main: expectedMain,
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: [...COMPATIBILITY_FLAGS],
    observability: { enabled: true, logs: { invocation_logs: false } },
    durable_objects: {
      bindings: [{
        name: "NUMBERS_MAILBOX",
        class_name: "NumbersMailbox",
      }],
    },
    exports: {
      NumbersMailbox: {
        type: "durable-object",
        storage: "sqlite",
        state: "created",
      },
    },
    kv_namespaces: [{ binding: "VIBEPULSE", id: expectedKvId }],
    secrets: { required: ["RELAY_SECRET"] },
  };
}

export async function runProductionDeployment(options, dependencies = {}) {
  const {
    mode, configPath, expectedKvId, expectedMain,
  } = options;
  if (mode !== "dry-run" && mode !== "deploy")
    throw guardError("mode must be dry-run or deploy");
  if (typeof configPath !== "string" || !isAbsolute(configPath) ||
      resolve(configPath) !== configPath)
    throw guardError("--config must be an absolute canonical path");

  let realConfigPath;
  let config;
  try {
    realConfigPath = realpathSync(configPath);
    config = JSON.parse(readFileSync(realConfigPath, "utf8"));
  } catch {
    throw guardError("production config must be readable strict JSON");
  }
  const canonicalConfig = validateProductionConfig(config, {
    configPath: realConfigPath,
    expectedKvId,
    expectedMain,
  });

  // The private config deliberately lives outside the repository. Supplying the
  // validated absolute entrypoint keeps Wrangler from resolving `main` relative
  // to that private file's directory.
  let entrypoint;
  try {
    entrypoint = realpathSync(resolve(RELAY_DIR, expectedMain));
  } catch {
    throw guardError("validated stage entrypoint is missing");
  }

  const signalRelay = installSignalRelay();
  let invocationResult;
  let invocationError;
  let snapshotDirectory;
  try {
    snapshotDirectory = mkdtempSync(
      join(tmpdir(), "vibepulse-relay-deploy-"),
    );
    if (isWithinRepository(realpathSync(snapshotDirectory)))
      throw guardError("private snapshot directory must be outside repository");
    chmodSync(snapshotDirectory, 0o700);
    const snapshotPath = join(snapshotDirectory, "wrangler.production.json");
    writeFileSync(
      snapshotPath,
      `${JSON.stringify(canonicalConfig, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    chmodSync(snapshotPath, 0o600);
    const args = [
      "deploy", entrypoint, "--config", snapshotPath,
      "--strict", "--keep-vars",
    ];
    if (mode === "dry-run") args.push("--dry-run");
    invocationResult = await invokeWrangler(args, dependencies, signalRelay);
  } catch (error) {
    invocationError = error;
  } finally {
    try {
      if (snapshotDirectory !== undefined)
        rmSync(snapshotDirectory, { recursive: true, force: true });
    } finally {
      signalRelay.dispose();
    }
  }
  if (invocationError !== undefined) throw invocationError;
  if (signalRelay.signal !== undefined)
    return signalResult(signalRelay.signal);
  return invocationResult;
}

export async function runCiDryBuild(dependencies = {}) {
  const signalRelay = installSignalRelay();
  let invocationError;
  try {
    for (const configPath of TEST_CONFIGS) {
      if (signalRelay.signal !== undefined) break;
      await invokeWrangler(
        ["deploy", "--config", configPath,
          "--strict", "--keep-vars", "--dry-run"],
        dependencies,
        signalRelay,
      );
    }
  } catch (error) {
    invocationError = error;
  } finally {
    signalRelay.dispose();
  }
  if (invocationError !== undefined) throw invocationError;
  if (signalRelay.signal !== undefined)
    return signalResult(signalRelay.signal);
  return {};
}

function parseProductionArgs(mode, args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--config", "--expected-kv-id", "--expected-main"].includes(flag) ||
        value === undefined || Object.hasOwn(values, flag))
      throw guardError("required flags are --config, --expected-kv-id, --expected-main");
    values[flag] = value;
  }
  return {
    mode,
    configPath: values["--config"],
    expectedKvId: values["--expected-kv-id"],
    expectedMain: values["--expected-main"],
  };
}

export async function runCli(args, dependencies = {}) {
  const [mode, ...rest] = args;
  if (mode === "ci-dry") {
    if (rest.length !== 0) throw guardError("ci-dry accepts no arguments");
    return runCiDryBuild(dependencies);
  }
  return runProductionDeployment(parseProductionArgs(mode, rest), dependencies);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href
                                    : "";
if (import.meta.url === invokedPath) {
  try {
    const result = await runCli(process.argv.slice(2));
    if (result?.exitCode !== undefined) process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "deploy guard: failed");
    process.exitCode = 1;
  }
}
