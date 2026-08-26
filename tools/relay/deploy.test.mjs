import assert from "node:assert/strict";
import { spawn as nativeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename, dirname, isAbsolute, join, relative, resolve,
} from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";


const RELAY_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(RELAY_DIR, "..", "..");
const REAL_KV_ID = "a".repeat(32);
const ZERO_KV_ID = "0".repeat(32);

function fakeChild(status = 0) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  queueMicrotask(() => {
    child.exitCode = status;
    child.emit("exit", status, null);
  });
  return child;
}

async function rejectsGuard(operation) {
  await assert.rejects(Promise.resolve().then(operation), /deploy guard:/);
}

async function waitFor(check, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  throw new Error(message);
}

function waitForChildExit(child, timeoutMs, message) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error(message));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    };
    child.once("exit", onExit);
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function productionConfig({
  main = "worker.js", kvId = REAL_KV_ID, name = "vibepulse-relay",
} = {}) {
  return {
    name,
    main,
    compatibility_date: "2026-08-22",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true, logs: { invocation_logs: false } },
    durable_objects: {
      bindings: [{
        name: "NUMBERS_MAILBOX",
        class_name: "NumbersMailbox",
      }],
    },
    exports: {
      NumbersMailbox: {
        type: "durable-object", storage: "sqlite", state: "created",
      },
    },
    kv_namespaces: [{ binding: "VIBEPULSE", id: kvId }],
    secrets: { required: ["RELAY_SECRET"] },
  };
}

function privateConfig(t, config = productionConfig()) {
  const directory = mkdtempSync(join(tmpdir(), "vibepulse-relay-config-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const configPath = join(directory, "production.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

function options(configPath, overrides = {}) {
  return {
    mode: "dry-run",
    configPath,
    expectedKvId: REAL_KV_ID,
    expectedMain: "worker.js",
    ...overrides,
  };
}

test("source config arguments are canonical absolute paths before resolution",
     async (t) => {
  const { runCli, runProductionDeployment } = await import("./deploy.mjs");
  const configPath = privateConfig(t);
  const traversalDirectory = join(dirname(configPath), "unused");
  mkdirSync(traversalDirectory);
  const relativePath = relative(process.cwd(), configPath);
  const dotdotPath = `${traversalDirectory}/../${basename(configPath)}`;
  let childCalls = 0;
  const dependencies = {
    spawn() {
      childCalls += 1;
      return fakeChild();
    },
  };

  for (const sourcePath of [relativePath, dotdotPath]) {
    await rejectsGuard(() => runProductionDeployment(
      options(sourcePath), dependencies,
    ));
    await rejectsGuard(() => runCli([
      "dry-run",
      "--config", sourcePath,
      "--expected-kv-id", REAL_KV_ID,
      "--expected-main", "worker.js",
    ], dependencies));
  }
  assert.equal(childCalls, 0);
});

test("invalid production configs never reach a child process", async (t) => {
  const { runProductionDeployment, validateProductionConfig } =
    await import("./deploy.mjs");
  let childCalls = 0;
  const dependencies = {
    spawn() {
      childCalls += 1;
      return fakeChild();
    },
  };

  const missingKv = productionConfig();
  delete missingKv.kv_namespaces;
  const missingBinding = productionConfig();
  delete missingBinding.durable_objects;
  const missingExport = productionConfig();
  delete missingExport.exports;
  const wrongBinding = productionConfig();
  wrongBinding.durable_objects.bindings[0].class_name = "WrongMailbox";
  const remoteBinding = productionConfig();
  remoteBinding.durable_objects.bindings[0].script_name = "other-worker";
  const wrongExport = productionConfig();
  wrongExport.exports.NumbersMailbox.storage = "legacy-kv";
  const extraLifecycleExport = productionConfig();
  extraLifecycleExport.exports.RetiredMailbox = { state: "deleted" };
  const missingSecret = productionConfig();
  delete missingSecret.secrets;
  const plaintextSecret = productionConfig();
  plaintextSecret.vars = { RELAY_SECRET: "must-not-be-committed" };
  const ordinaryVar = productionConfig();
  ordinaryVar.vars = { ENVIRONMENT: "production" };
  const routes = productionConfig();
  routes.routes = ["example.com/*"];
  const environment = productionConfig();
  environment.env = { production: {} };
  const otherBindingFamily = productionConfig();
  otherBindingFamily.r2_buckets = [{
    binding: "ARCHIVE", bucket_name: "not-allowed",
  }];
  const arbitraryTopLevel = productionConfig();
  arbitraryTopLevel.send_metrics = false;
  const wrongDate = productionConfig();
  wrongDate.compatibility_date = "2026-08-21";
  const missingFlags = productionConfig();
  delete missingFlags.compatibility_flags;
  const extraFlag = productionConfig();
  extraFlag.compatibility_flags.push("experimental");
  const wrongObservability = productionConfig();
  wrongObservability.observability.enabled = false;
  const extraObservabilityKey = productionConfig();
  extraObservabilityKey.observability.head_sampling_rate = 1;
  const missingLogs = productionConfig();
  delete missingLogs.observability.logs;
  const invocationLogsOn = productionConfig();
  invocationLogsOn.observability.logs.invocation_logs = true;
  const extraLogsKey = productionConfig();
  extraLogsKey.observability.logs.head_sampling_rate = 1;
  const extraKv = productionConfig();
  extraKv.kv_namespaces.push({
    binding: "OTHER_KV", id: "c".repeat(32),
  });
  const extraKvKey = productionConfig();
  extraKvKey.kv_namespaces[0].preview_id = REAL_KV_ID;
  const extraDurableObjectKey = productionConfig();
  extraDurableObjectKey.durable_objects.extra = true;
  const missingExportState = productionConfig();
  delete missingExportState.exports.NumbersMailbox.state;
  const extraSecret = productionConfig();
  extraSecret.secrets.required.push("OTHER_SECRET");
  const extraSecretsKey = productionConfig();
  extraSecretsKey.secrets.extra = true;

  const repositoryDirectory = mkdtempSync(
    join(RELAY_DIR, ".production-config-test-"),
  );
  t.after(() => rmSync(repositoryDirectory, { recursive: true, force: true }));
  const repositoryConfig = join(repositoryDirectory, "production.json");
  writeFileSync(repositoryConfig, JSON.stringify(productionConfig()), "utf8");
  const symlinkDirectory = mkdtempSync(
    join(tmpdir(), "vibepulse-relay-symlink-"),
  );
  t.after(() => rmSync(symlinkDirectory, { recursive: true, force: true }));
  const repositoryConfigSymlink = join(symlinkDirectory, "production.json");
  symlinkSync(repositoryConfig, repositoryConfigSymlink);

  const invalid = [
    options(privateConfig(t, productionConfig({ name: "wrong-worker" }))),
    options(privateConfig(t, productionConfig({ main: "wrong.js" }))),
    options(privateConfig(t, missingKv)),
    options(privateConfig(t, productionConfig({ kvId: "b".repeat(32) }))),
    options(privateConfig(t, missingBinding)),
    options(privateConfig(t, wrongBinding)),
    options(privateConfig(t, remoteBinding)),
    options(privateConfig(t, missingExport)),
    options(privateConfig(t, wrongExport)),
    options(privateConfig(t, extraLifecycleExport)),
    options(privateConfig(t, missingSecret)),
    options(privateConfig(t, plaintextSecret)),
    options(privateConfig(t, ordinaryVar)),
    options(privateConfig(t, routes)),
    options(privateConfig(t, environment)),
    options(privateConfig(t, otherBindingFamily)),
    options(privateConfig(t, arbitraryTopLevel)),
    options(privateConfig(t, wrongDate)),
    options(privateConfig(t, missingFlags)),
    options(privateConfig(t, extraFlag)),
    options(privateConfig(t, wrongObservability)),
    options(privateConfig(t, extraObservabilityKey)),
    options(privateConfig(t, missingLogs)),
    options(privateConfig(t, invocationLogsOn)),
    options(privateConfig(t, extraLogsKey)),
    options(privateConfig(t, extraKv)),
    options(privateConfig(t, extraKvKey)),
    options(privateConfig(t, extraDurableObjectKey)),
    options(privateConfig(t, missingExportState)),
    options(privateConfig(t, extraSecret)),
    options(privateConfig(t, extraSecretsKey)),
    options(repositoryConfigSymlink),
    options(privateConfig(t), { expectedKvId: ZERO_KV_ID }),
    options(privateConfig(t), { expectedMain: "wrong.js" }),
    options(resolve(RELAY_DIR, "wrangler.test.jsonc")),
  ];

  for (const invalidOptions of invalid)
    await rejectsGuard(
      () => runProductionDeployment(invalidOptions, dependencies),
    );
  assert.throws(() => validateProductionConfig(productionConfig(), {
    configPath: resolve(RELAY_DIR, "..", "private.json"),
    expectedKvId: REAL_KV_ID,
    expectedMain: "worker.js",
  }), /absolute private/);
  assert.equal(childCalls, 0);
});

test("valid private configs invoke pinned Wrangler with private canonical snapshots",
     async (t) => {
  const { runProductionDeployment } = await import("./deploy.mjs");
  const calls = [];
  let originalPath;
  const dependencies = {
    spawn(command, args, spawnOptions) {
      const snapshotPath = args[args.indexOf("--config") + 1];
      writeFileSync(originalPath, JSON.stringify({ hijacked: true }), "utf8");
      const snapshotBytes = readFileSync(snapshotPath, "utf8");
      const snapshotMode = statSync(snapshotPath).mode & 0o777;
      calls.push({
        command, args, spawnOptions, snapshotPath, snapshotBytes, snapshotMode,
      });
      return fakeChild();
    },
  };
  const bootstrapPath = privateConfig(
    t, productionConfig({ main: "bootstrap.js" }),
  );
  const workerPath = privateConfig(t);
  const reordered = productionConfig();
  reordered.exports.NumbersMailbox = {
    storage: "sqlite",
    type: "durable-object",
    state: "created",
  };
  const reorderedPath = privateConfig(t, reordered);

  originalPath = bootstrapPath;
  await runProductionDeployment(options(bootstrapPath, {
    expectedMain: "bootstrap.js",
  }), dependencies);
  originalPath = workerPath;
  await runProductionDeployment(
    options(workerPath, { mode: "deploy" }), dependencies,
  );
  originalPath = reorderedPath;
  await runProductionDeployment(options(reorderedPath), dependencies);

  assert.equal(calls.length, 3);
  assert.match(calls[0].command, /node_modules[/\\]\.bin[/\\]wrangler/);
  assert.deepEqual(calls[0].args.filter((arg) => arg !== calls[0].snapshotPath), [
    "deploy", resolve(RELAY_DIR, "bootstrap.js"),
    "--config", "--strict", "--keep-vars", "--dry-run",
  ]);
  assert.deepEqual(calls[1].args.filter((arg) => arg !== calls[1].snapshotPath), [
    "deploy", resolve(RELAY_DIR, "worker.js"),
    "--config", "--strict", "--keep-vars",
  ]);
  assert.deepEqual(calls[2].args.filter((arg) => arg !== calls[2].snapshotPath), [
    "deploy", resolve(RELAY_DIR, "worker.js"),
    "--config", "--strict", "--keep-vars", "--dry-run",
  ]);
  assert.equal(calls[0].spawnOptions.cwd, RELAY_DIR);
  assert.equal(calls[0].snapshotBytes,
               `${JSON.stringify(productionConfig({ main: "bootstrap.js" }), null, 2)}\n`);
  assert.equal(calls[1].snapshotBytes,
               `${JSON.stringify(productionConfig(), null, 2)}\n`);
  assert.equal(calls[2].snapshotBytes,
               `${JSON.stringify(productionConfig(), null, 2)}\n`);
  for (const call of calls) {
    assert.equal(call.snapshotMode, 0o600);
    assert.ok(isAbsolute(call.snapshotPath));
    const repositoryRelative = relative(REPOSITORY_ROOT, call.snapshotPath);
    assert.ok(repositoryRelative.startsWith("..") ||
              isAbsolute(repositoryRelative));
    assert.equal(existsSync(call.snapshotPath), false);
    assert.equal(existsSync(dirname(call.snapshotPath)), false);
  }
});

test("private snapshots are removed after Wrangler failure",
     async (t) => {
  const { runProductionDeployment } = await import("./deploy.mjs");
  let snapshotPath;
  await rejectsGuard(() => runProductionDeployment(
    options(privateConfig(t)),
    {
      spawn(_command, args) {
        snapshotPath = args[args.indexOf("--config") + 1];
        assert.equal(existsSync(snapshotPath), true);
        return fakeChild(17);
      },
    },
  ));
  assert.equal(existsSync(snapshotPath), false);
  assert.equal(existsSync(dirname(snapshotPath)), false);
});

test("a child that never confirms exit rejects after bounded termination",
     async (t) => {
  const { runCiDryBuild, runProductionDeployment } =
    await import("./deploy.mjs");

  await t.test("production deployment", async (t) => {
    const kills = [];
    let snapshotPath;
    const signalListeners = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      kills.push(signal);
      return true;
    };

    await assert.rejects(runProductionDeployment(
      options(privateConfig(t)),
      {
        signalGraceMs: 1,
        signalKillGraceMs: 1,
        spawn(_command, args) {
          snapshotPath = args[args.indexOf("--config") + 1];
          queueMicrotask(() => process.emit("SIGTERM"));
          return child;
        },
      },
    ), /deploy guard: Wrangler did not exit after termination/);

    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
    assert.equal(existsSync(snapshotPath), false);
    assert.equal(existsSync(dirname(snapshotPath)), false);
    assert.equal(process.listenerCount("SIGINT"), signalListeners.SIGINT);
    assert.equal(process.listenerCount("SIGTERM"), signalListeners.SIGTERM);
  });

  await t.test("CI dry build", async () => {
    const kills = [];
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      kills.push(signal);
      return true;
    };

    await assert.rejects(runCiDryBuild({
      signalGraceMs: 1,
      signalKillGraceMs: 1,
      spawn() {
        queueMicrotask(() => process.emit("SIGINT"));
        return child;
      },
    }), /deploy guard: Wrangler did not exit after termination/);

    assert.deepEqual(kills, ["SIGINT", "SIGKILL"]);
  });
});

test("real SIGINT and SIGTERM forward, clean snapshots, and leave no child",
     { skip: process.platform === "win32" }, async (t) => {
  const deployUrl = pathToFileURL(join(RELAY_DIR, "deploy.mjs")).href;
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    await t.test(signal, async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "vibepulse-signal-test-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const snapshotRoot = join(directory, "snapshots");
      mkdirSync(snapshotRoot, { mode: 0o700 });
      const childPath = join(directory, "blocking-child.mjs");
      const runnerPath = join(directory, "guard-runner.mjs");
      const childPidPath = join(directory, "child.pid");
      const signalPath = join(directory, "child.signal");
      const snapshotPathMarker = join(directory, "snapshot.path");
      const configPath = join(directory, "production.json");
      writeFileSync(configPath, JSON.stringify(productionConfig()), "utf8");
      writeFileSync(childPath, `
        import { writeFileSync } from "node:fs";
        const [pidPath, signalPath] = process.argv.slice(2);
        writeFileSync(pidPath, String(process.pid));
        for (const signal of ["SIGINT", "SIGTERM"])
          process.on(signal, () => writeFileSync(signalPath, signal));
        setInterval(() => {}, 1_000);
      `, "utf8");
      writeFileSync(runnerPath, `
        import { spawn as nativeSpawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        import { runProductionDeployment } from ${JSON.stringify(deployUrl)};
        const [configPath, childPath, pidPath, signalPath, snapshotPathMarker] =
          process.argv.slice(2);
        const result = await runProductionDeployment({
          mode: "dry-run",
          configPath,
          expectedKvId: ${JSON.stringify(REAL_KV_ID)},
          expectedMain: "worker.js",
        }, {
          signalGraceMs: 100,
          signalKillGraceMs: 2_000,
          spawn(_command, args, options) {
            const snapshotPath = args[args.indexOf("--config") + 1];
            writeFileSync(snapshotPathMarker, snapshotPath);
            return nativeSpawn(process.execPath,
              [childPath, pidPath, signalPath],
              { ...options, stdio: "ignore" });
          },
        });
        if (result?.exitCode !== undefined) process.exitCode = result.exitCode;
      `, "utf8");

      const wrapper = nativeSpawn(process.execPath, [
        runnerPath, configPath, childPath, childPidPath, signalPath,
        snapshotPathMarker,
      ], {
        env: { ...process.env, TMPDIR: snapshotRoot },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      wrapper.stderr.setEncoding("utf8");
      wrapper.stderr.on("data", (chunk) => { stderr += chunk; });
      let childPid;
      t.after(() => {
        if (wrapper.exitCode === null && wrapper.signalCode === null)
          wrapper.kill("SIGKILL");
        if (childPid && processExists(childPid)) process.kill(childPid, "SIGKILL");
      });

      await waitFor(() => existsSync(childPidPath),
                    `${signal} fixture child did not start`);
      childPid = Number(readFileSync(childPidPath, "utf8"));
      assert.equal(processExists(childPid), true);
      assert.equal(existsSync(snapshotPathMarker), true);
      const snapshotPath = readFileSync(snapshotPathMarker, "utf8");
      assert.equal(snapshotPath.startsWith(`${snapshotRoot}/`), true);
      assert.equal(existsSync(snapshotPath), true);
      const exitPromise = waitForChildExit(
        wrapper, 5_000, `${signal} wrapper hung`,
      );
      wrapper.kill(signal);

      const exit = await exitPromise;
      assert.deepEqual(exit, { code: exitCode, signal: null }, stderr);
      await waitFor(() => existsSync(signalPath),
                    `${signal} was not forwarded to child`);
      assert.equal(readFileSync(signalPath, "utf8"), signal);
      assert.deepEqual(readdirSync(snapshotRoot), []);
      assert.equal(existsSync(snapshotPath), false);
      assert.equal(existsSync(dirname(snapshotPath)), false);
      await waitFor(() => !processExists(childPid),
                    `${signal} left child ${String(childPid)} running`);
    });
  }
});

test("CI dry build compiles both staged entrypoints without a deploy mode",
     async () => {
  const { runCiDryBuild } = await import("./deploy.mjs");
  const calls = [];
  await runCiDryBuild({
    spawn(command, args) {
      calls.push({ command, args });
      return fakeChild();
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.args), [
    ["deploy", "--config", resolve(RELAY_DIR, "wrangler.test.jsonc"),
      "--strict", "--keep-vars", "--dry-run"],
    ["deploy", "--config", resolve(RELAY_DIR, "wrangler.worker.test.jsonc"),
      "--strict", "--keep-vars", "--dry-run"],
  ]);
  for (const call of calls) {
    assert.match(call.command, /node_modules[/\\]\.bin[/\\]wrangler/);
    assert.ok(call.args.includes("--dry-run"));
  }
});

test("committed configs are test-only while plain Wrangler is disabled",
     () => {
  const defaultConfig = JSON.parse(
    readFileSync(join(RELAY_DIR, "wrangler.jsonc"), "utf8"),
  );
  assert.equal(defaultConfig.main, "DEPLOY_DISABLED_USE_GUARD.js");
  assert.equal(defaultConfig.kv_namespaces, undefined);

  for (const [file, main] of [
    ["wrangler.test.jsonc", "bootstrap.js"],
    ["wrangler.worker.test.jsonc", "worker.js"],
  ]) {
    const config = JSON.parse(readFileSync(join(RELAY_DIR, file), "utf8"));
    assert.match(config.name, /-test$/);
    assert.equal(config.main, main);
    assert.deepEqual(config.secrets, { required: ["RELAY_SECRET"] });
    assert.deepEqual(config.durable_objects.bindings, [{
      name: "NUMBERS_MAILBOX", class_name: "NumbersMailbox",
    }]);
    assert.deepEqual(config.exports.NumbersMailbox, {
      type: "durable-object", storage: "sqlite",
    });
    assert.deepEqual(config.kv_namespaces, [{
      binding: "VIBEPULSE", id: ZERO_KV_ID,
    }]);
    // Invocation logs keep the secret URL for seven days; only the app's
    // own metadata-only console output may reach Workers Logs.
    assert.deepEqual(config.observability, {
      enabled: true, logs: { invocation_logs: false },
    });
  }
});
