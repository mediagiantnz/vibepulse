#!/usr/bin/env node

/*
 * Guarded redeploy for the interaction relay Worker.
 *
 * The committed wrangler.jsonc carries a placeholder MAILBOX_ID so the
 * config can be linted and dry-built in a fresh clone. A plain
 * `wrangler deploy` would publish that placeholder over the random mailbox
 * id that `tools/vibepulse_setup.py relay install` deployed with `--var`,
 * and the Mac and panel would keep talking to a mailbox the Worker no
 * longer serves. This wrapper refuses to deploy unless the installed
 * mailbox id is supplied explicitly and differs from the placeholder.
 *
 * Usage: node deploy.mjs --mailbox-id vp_<16 url-safe chars> [--dry-run]
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVICE_DIR = dirname(fileURLToPath(import.meta.url));
const MAILBOX_PATTERN = /^vp_[A-Za-z0-9_-]{16}$/;
export const PLACEHOLDER_MAILBOX_ID = "vp_A1b2C3d4E5f6G7h8";

function guardError(message) {
  return new Error(`deploy guard: ${message}`);
}

function pinnedWrangler() {
  const executable = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  return resolve(SERVICE_DIR, "node_modules", ".bin", executable);
}

export function committedMailboxId(configPath =
                                     resolve(SERVICE_DIR, "wrangler.jsonc")) {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const value = config?.vars?.MAILBOX_ID;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function validateMailboxId(mailboxId, committed = committedMailboxId()) {
  if (typeof mailboxId !== "string" || !MAILBOX_PATTERN.test(mailboxId))
    throw guardError("--mailbox-id must be vp_ followed by 16 URL-safe characters");
  if (mailboxId === PLACEHOLDER_MAILBOX_ID || mailboxId === committed)
    throw guardError(
      "--mailbox-id is the committed placeholder; pass the installed " +
      "mailbox id (TK_VIBEPULSE_INTERACTION_MAILBOX in secrets.h)",
    );
  return mailboxId;
}

export function parseArgs(args) {
  let mailboxId;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--dry-run") {
      dryRun = true;
    } else if (flag === "--mailbox-id" && mailboxId === undefined &&
               index + 1 < args.length) {
      mailboxId = args[index + 1];
      index += 1;
    } else {
      throw guardError("usage: --mailbox-id <vp_...> [--dry-run]");
    }
  }
  if (mailboxId === undefined)
    throw guardError("usage: --mailbox-id <vp_...> [--dry-run]");
  return { mailboxId, dryRun };
}

function childExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", () => reject(guardError("Wrangler could not start")));
    child.once("exit", (status, signal) => resolveExit({ status, signal }));
  });
}

export async function runDeploy(args, { spawn = nodeSpawn } = {}) {
  const { mailboxId, dryRun } = parseArgs(args);
  validateMailboxId(mailboxId);
  const wranglerArgs = ["deploy", "--var", `MAILBOX_ID:${mailboxId}`];
  if (dryRun) wranglerArgs.push("--dry-run");
  let child;
  try {
    child = spawn(pinnedWrangler(), wranglerArgs, {
      cwd: SERVICE_DIR,
      stdio: "inherit",
    });
  } catch {
    throw guardError("Wrangler could not start");
  }
  const exit = await childExit(child);
  if (exit.status !== 0) {
    if (exit.signal) throw guardError(`Wrangler exited from ${exit.signal}`);
    throw guardError(`Wrangler exited with status ${String(exit.status)}`);
  }
  return { mailboxId, dryRun };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href
                                    : "";
if (import.meta.url === invokedPath) {
  try {
    await runDeploy(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "deploy guard: failed");
    process.exitCode = 1;
  }
}
