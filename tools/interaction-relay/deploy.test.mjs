import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PLACEHOLDER_MAILBOX_ID, committedMailboxId, parseArgs, runDeploy,
  validateMailboxId,
} from "./deploy.mjs";

const SERVICE_DIR = dirname(fileURLToPath(import.meta.url));
const REAL_MAILBOX_ID = "vp_zZ9yY8xX7wW6vV5u";

function fakeChild(status = 0) {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", status, null));
  return child;
}

test("the committed config carries the placeholder, never a real mailbox",
     () => {
  assert.equal(committedMailboxId(), PLACEHOLDER_MAILBOX_ID);
  const config = JSON.parse(
    readFileSync(join(SERVICE_DIR, "wrangler.jsonc"), "utf8"),
  );
  assert.deepEqual(config.vars, { MAILBOX_ID: PLACEHOLDER_MAILBOX_ID });
});

test("the placeholder and malformed ids are refused before any child runs",
     async () => {
  let childCalls = 0;
  const spawn = () => {
    childCalls += 1;
    return fakeChild();
  };
  for (const mailboxId of [
    PLACEHOLDER_MAILBOX_ID, "vp_short", "vp_" + "x".repeat(17),
    "xx_" + "a".repeat(16), "vp_" + "a".repeat(15) + "!", "", "vp_",
  ])
    await assert.rejects(
      runDeploy(["--mailbox-id", mailboxId], { spawn }), /deploy guard:/,
      mailboxId,
    );
  assert.throws(() => validateMailboxId(REAL_MAILBOX_ID, REAL_MAILBOX_ID),
                /placeholder/);
  assert.equal(childCalls, 0);
});

test("missing, repeated, or unknown flags are usage errors", () => {
  for (const args of [
    [], ["--dry-run"], ["--mailbox-id"], ["--mailbox-id", REAL_MAILBOX_ID,
      "--mailbox-id", REAL_MAILBOX_ID], ["--var", "MAILBOX_ID:x"],
    ["--mailbox-id", REAL_MAILBOX_ID, "--yes"],
  ])
    assert.throws(() => parseArgs(args), /deploy guard: usage/);
  assert.deepEqual(parseArgs(["--mailbox-id", REAL_MAILBOX_ID]),
                   { mailboxId: REAL_MAILBOX_ID, dryRun: false });
  assert.deepEqual(parseArgs(["--dry-run", "--mailbox-id", REAL_MAILBOX_ID]),
                   { mailboxId: REAL_MAILBOX_ID, dryRun: true });
});

test("a real mailbox id deploys through pinned Wrangler with --var", async () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return fakeChild();
  };
  await runDeploy(["--mailbox-id", REAL_MAILBOX_ID], { spawn });
  await runDeploy(["--mailbox-id", REAL_MAILBOX_ID, "--dry-run"], { spawn });
  assert.equal(calls.length, 2);
  assert.match(calls[0].command, /node_modules[/\\]\.bin[/\\]wrangler/);
  assert.deepEqual(calls[0].args,
                   ["deploy", "--var", `MAILBOX_ID:${REAL_MAILBOX_ID}`]);
  assert.deepEqual(calls[1].args,
                   ["deploy", "--var", `MAILBOX_ID:${REAL_MAILBOX_ID}`,
                     "--dry-run"]);
  for (const call of calls) {
    assert.equal(call.options.cwd, SERVICE_DIR);
    assert.ok(!call.args.includes("--keep-vars"),
              "vars must come from the flag, never from a previous deploy");
  }
});

test("a failing Wrangler is reported as a guard error", async () => {
  await assert.rejects(
    runDeploy(["--mailbox-id", REAL_MAILBOX_ID], { spawn: () => fakeChild(2) }),
    /deploy guard: Wrangler exited with status 2/,
  );
});

test("package scripts route deploys through the guard", () => {
  const pkg = JSON.parse(readFileSync(join(SERVICE_DIR, "package.json"), "utf8"));
  assert.equal(pkg.scripts.deploy, "node deploy.mjs");
  assert.equal(pkg.scripts["deploy:dry"], "wrangler deploy --dry-run");
  assert.match(pkg.scripts.test, /node --test deploy\.test\.mjs/);
});
