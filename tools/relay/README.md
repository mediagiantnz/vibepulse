# The relay mailbox

A small Cloudflare Worker that lets the panel fetch its numbers from anywhere,
instead of only from the same LAN as the service. Full design
rationale and what may/may not cross it: [docs/relay.md](../../docs/relay.md).

## Deploy safely

Install the pinned local toolchain with `npm ci`. The committed
`wrangler.jsonc` is intentionally non-deployable, and the all-zero namespace
IDs live only in `*-test.jsonc`. Do not create a `wrangler.toml` or run plain
`wrangler deploy`; that bypasses the identity checks needed for the existing
private mailbox.

Create an absolute private strict-JSON config outside the repository. Copy this
complete shape exactly, then replace the KV placeholder with the existing real
namespace ID. The ID must be 32 lowercase hexadecimal characters; do not create
a new namespace because the bootstrap rollback path needs the existing data.

```json
{
  "name": "vibepulse-relay",
  "main": "bootstrap.js",
  "compatibility_date": "2026-08-22",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true,
    "logs": {
      "invocation_logs": false
    }
  },
  "durable_objects": {
    "bindings": [
      {
        "name": "NUMBERS_MAILBOX",
        "class_name": "NumbersMailbox"
      }
    ]
  },
  "exports": {
    "NumbersMailbox": {
      "type": "durable-object",
      "storage": "sqlite",
      "state": "created"
    }
  },
  "kv_namespaces": [
    {
      "binding": "VIBEPULSE",
      "id": "REPLACE_WITH_EXISTING_32_HEX_KV_NAMESPACE_ID"
    }
  ],
  "secrets": {
    "required": ["RELAY_SECRET"]
  }
}
```

The binding is deliberately local: do not add `script_name` or `environment`.
`NumbersMailbox` must be the only lifecycle export. Keep `RELAY_SECRET` in the
Worker secret store; `secrets.required` declares its name but never its value.
The guard rejects every additional top-level field, binding, route, environment,
variable, flag, secret declaration, or nested object key.

`observability.logs.invocation_logs` must be `false` and the guard enforces it.
Workers Logs invocation logs retain the request URL and headers for seven days,
and for this Worker the URL is the credential. The app's own `console.error`
diagnostics (event name and operation only, never a secret, publisher, or body)
still reach Workers Logs. If an earlier deployment ran with invocation logs on,
rotate `RELAY_SECRET` after redeploying with this configuration: the old secret
was visible in that log window.
The staged rollout is documented in the
[coordinated-mailbox design](../../docs/superpowers/specs/2026-08-22-vibepulse-numbers-relay-list-free-design.md): bootstrap first, then the active Worker.

```sh
cd tools/relay
npm ci
npm run build:dry
npm run deploy:dry -- \
  --config /absolute/private/vibepulse-relay.production.json \
  --expected-kv-id <existing-real-kv-id> \
  --expected-main bootstrap.js
npm run deploy -- \
  --config /absolute/private/vibepulse-relay.production.json \
  --expected-kv-id <existing-real-kv-id> \
  --expected-main bootstrap.js
```

The wrapper invokes pinned Wrangler with `--strict --keep-vars`. The `--config`
argument itself must be an absolute canonical path; relative paths and paths
spelled with `..` are rejected before filesystem or symlink resolution. After
resolving the real external config path, the wrapper serializes only the
validated fields to a mode-0600 canonical snapshot outside the repository and
uses the validated absolute entrypoint. Wrangler never receives the mutable
source path, and the wrapper removes the snapshot after Wrangler exits on
success or failure.

Handled `SIGINT` and `SIGTERM` are forwarded to Wrangler. The wrapper waits a
bounded time for the child and force-stops a child that does not exit. Status
130 or 143 is reported only after Wrangler confirms exit. If the child still
does not report exit after forced termination, the wrapper removes the snapshot
but fails with a deploy-guard error; it does not claim the child was reaped. An
abrupt `SIGKILL` cannot run cleanup; inspect the private system temporary
directory before retrying after such a crash.

The first deployment provisions the SQLite class while `bootstrap.js` keeps
serving the old KV path. Confirm that public behavior, then capture that exact
bootstrap version. Change only `main` from `bootstrap.js` to `worker.js` in the
private JSON and repeat the guarded dry-run/deploy commands with
`--expected-main worker.js`. The active Worker does not read or write KV; the
existing binding and data remain only for the bootstrap rollback path.

After class creation, rollback is allowed only to the captured bootstrap
version, never directly to a pre-Durable-Object version. Do not delete the old
KV data while this rollback path is retained.

The mailbox address remains:

```
https://vibepulse-relay.<your-subdomain>.workers.dev/u/<the secret>
```

The secret never lives in code or in this repo — it exists in the Worker's
secret store, in your `secrets.h`, and in the service's start command.

## Wire it up

**Service side** (each machine that should publish — one or several):

```sh
python3 tools/tokenserver/tokenserver.py --publish "https://.../u/<secret>"
```

**Panel side** (`secrets.h`, then build + OTA once):

```c
#define TK_VIBEPULSE_RELAY_URL "https://.../u/<secret>"
```

## Verify

```sh
curl -s https://.../u/<secret>/api/tokens | head -c 200   # JSON within 30 s
```

The SQLite mailbox starts empty when `worker.js` becomes active. Restart every
active tokenserver so its immediate first pass republishes `/api/tokens`,
`/api/max-tracker`, and `/api/github`.

`node --test tools/relay/test.mjs` holds the merge logic still without any
Cloudflare involvement. `npm test` runs the real Worker/Durable Object runtime
and deployment-guard regressions. `npm run build:dry` makes pinned Wrangler
compile both staged test entrypoints with `--dry-run`; it cannot deploy.

## Free-tier arithmetic

The panel makes 2,880 poll cycles per day. Three endpoints per cycle are 8,640
panel GETs and 8,640 mailbox RPCs. On the healthy-success path, each publisher
is capped at 288 admitted token, 48 Max Tracker, and 48 GitHub publications per
day: 384 total for one publisher or 768 for two.

Each admitted publication changes one monotonic counter row and one document
row. Billed SQLite writes also include index maintenance. Conservatively allow
up to four billed rows per publication, plus up to two for a publisher's first
registration, so the scheduled maximum remains under 1,600 billed row writes
per day for one publisher or under 3,100 for two. These are deliberately rounded
upper bounds, not exact SQLite billing arithmetic, and remain far below the
100,000-row daily free limit. The fixed eight-publisher limit bounds every read.
A ninth name evicts the quietest registered publisher (at most three document
rows and one registry row deleted) before it registers; that only happens on a
new name's first publication, never on the steady-state path.

A failed POST is not admitted and does not advance the publisher's send time,
so it can retry on the next 30-second check. The successful-publication and row
totals above are therefore not a hard ceiling on failed request attempts.
