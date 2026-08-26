# The numbers relay — numbers from anywhere

The panel normally reads numbers directly from the tokenserver over the LAN.
That path cannot cross client isolation, an IoT VLAN, a sleeping computer's old
address, or unrelated Wi-Fi networks. The optional numbers relay supplies a
cloud fallback without widening the data boundary: it carries numbers only and
is off by default. This numbers transport never carries activity.

This is an open-source, user-owned feature. A fresh clone has no relay address,
Cloudflare account, namespace, or secret configured. Enabling it is a separate
choice from Claude interactions, Codex interactions, the encrypted interaction
relay, and the encrypted live-status relay. OAuth tokens, prompts, commands,
file contents, project names, and verdicts never enter this transport.

## Active architecture

```text
 Mac publisher ──POST──► public Worker ──RPC──► one SQLite-backed
 PC publisher  ──POST──► auth + validation       NumbersMailbox Durable Object
                               ▲                           │
 panel on any Wi-Fi ───GET─────┘◄──────────────────────────┘

 VIBEPULSE KV ── bootstrap and rollback only; inactive in worker.js
```

The public Worker owns the existing wire contract. It authenticates the secret
URL in constant time (both sides are hashed before a fixed-width compare, so a
wrong secret costs the same whether its first or last character is wrong),
accepts only `/api/tokens`, `/api/max-tracker`, and `/api/github`, validates
and bounds POST bodies, sanitizes publisher names, marks every response
`Cache-Control: no-store`, and returns the same JSON, status codes, and content
types the panel already understands. Every accepted request selects one
deterministic mailbox through the local `NUMBERS_MAILBOX` binding.

A POST body must be a numbers document: a JSON object of at most 64 KiB
(measured in UTF-8 bytes) whose values are numbers, booleans, `null`, strings
of at most 160 characters, or containers nested at most four deep (Max Tracker
is the deepest honest shape: root, provider, day list, day pair). Objects carry
at most 128 identifier-style keys, lists at most 512 entries, and a document at
most 4,096 values in total. Anything else is refused with `400 bad shape` before
it reaches storage, so the mailbox cannot be repurposed as a note pad. Every
field the tokenserver publisher sends today fits comfortably; the three real
worst-case documents are fixtures in `tools/relay/fixtures.mjs`.

The SQLite-backed `NumbersMailbox` Durable Object is the coordinator. It owns:

- a publisher registry capped at eight names;
- one latest document per endpoint and publisher; and
- a singleton monotonic receipt counter used to order whole documents.

Registration, counter increment, and document storage commit in one synchronous
SQLite transaction. When all eight names are taken and a ninth arrives, the
same transaction evicts the registered publisher whose newest document is
oldest (its rows are deleted) and registers the newcomer; the publisher that is
publishing is never the one evicted, and a publish from an already registered
name never evicts anybody. GET reads the known document rows directly; one
corrupt row is skipped without hiding healthy publishers. The active `worker.js` request path
does not read or write KV and never calls KV list. The existing `VIBEPULSE`
binding and data are retained only for bootstrap and rollback.

The panel still prefers its direct LAN URL. It falls back to the public Worker
only when LAN access fails, so home traffic stays local when the direct source
is healthy and the same numbers remain available on any ordinary internet
Wi-Fi when it is not.

## The boundary: numbers only

The same boundary is enforced in three places: firmware
(`test/test_relay_boundary.py`), the tokenserver publisher, and the public
Worker's three-path allowlist.

| Over this numbers relay | Never in this transport |
|---|---|
| `/api/tokens` — quota, reset, burn rate | `/api/agent-status` — activity and project names |
| `/api/max-tracker` — numeric history | Needs You questions and commands |
| `/api/github` — public repository counts | answers, verdicts, or device keys |

Access control is a long secret URL, like a private share link. That is a
reasonable boundary for percentages and public counts, not for work content.
Because the URL is the credential, the Worker configuration keeps Cloudflare's
Workers Logs enabled for the app's own metadata-only diagnostics but turns
platform invocation logs off (`observability.logs.invocation_logs: false`):
invocation logs would otherwise retain every request URL, secret included, for
seven days in the Cloudflare dashboard. If you deployed this Worker with the
earlier configuration (invocation logs on), assume the secret sat in that log
window and rotate it: set a new `RELAY_SECRET`, update `TK_VIBEPULSE_RELAY_URL`
in `secrets.h`, rebuild, and restart every publishing tokenserver with the new
`--publish` URL.
Remote questions, verdicts, or live activity require the separate explicit
end-to-end encrypted features described in
[docs/interaction-relay.md](interaction-relay.md). Enabling this numbers relay
never enables either encrypted activity feature.

## Multiple publishers

Every quota pool carries its own observation timestamp
(`claudeWeekObservedAt`, `claudeModelWeekObservedAt`,
`codexWeekObservedAt`, and similar fields). `/api/tokens` merges each pool from
the publisher that observed that pool most recently. Claude numbers can
therefore come from an always-on PC while Codex numbers come from the Mac where
Codex ran. Cached stale values retain their original observation time, so a
recently published old cache cannot outrank a genuinely newer reading.

Two rules keep that merge honest across machines:

- A publisher's clock is trusted only up to the moment of receipt. The mailbox
  clamps every top-level `*ObservedAt` to the Worker's wall time when it is
  ahead of it, so a machine with a fast clock cannot win every pool for as
  long as it stays ahead. Older stamps are stored exactly as claimed.
- The whole pool follows its winner. Before the winner's fields are copied,
  every field of that pool from every document is dropped, so a winner that
  did not send, say, `claudeWeekStale` never ends up with its own `Pct` beside
  another machine's stale flag or reset countdown.

### Publisher names and slots

Each publishing machine names itself with its short hostname (the part before
the first dot of `socket.gethostname()`, or `--publish-name` if given). That
name travels in the `X-VibePulse-Publisher` header and the Worker stores it
in the mailbox's `publishers` table beside that machine's latest documents,
so the hostname of every machine that has published is visible to whoever
owns the Cloudflare account. It is never returned to the panel. Choose
`--publish-name` if the hostname says more than you want a mailbox to hold.

The mailbox keeps eight names. Renaming a machine, reinstalling it, or
pointing a ninth machine at the same secret does not fill the mailbox for
good: the newcomer takes the slot of the name whose newest document is
oldest, so a name that stopped publishing months ago is the first to go and
active machines are never displaced by one another. No dashboard step is
needed to free a slot; publishing again re-registers a name.

Max Tracker and GitHub retain whole-document semantics. For those endpoints,
the mailbox-owned receipt counter makes the most recently stored publication
win. Max Tracker history is per machine; combining days from different
publishers would invent a history no machine observed.

The honest limits remain:

- Codex quota updates only after Codex runs on a publishing machine.
- A computer must be awake and its tokenserver must be running to publish.
- Agent activity remains local unless its separate encrypted relay is enabled.

## Daily successful-request and conservative row budget

The panel polls each of three endpoints every 30 seconds. One day therefore has
2,880 poll cycles and 8,640 panel GETs. Every GET is one public Worker request
and one Durable Object RPC.

Successfully admitted cloud publications have independent hard ceilings, even
when payload fields change on every local 30-second check:

| Endpoint | Minimum interval | Maximum per publisher per day |
|---|---:|---:|
| `/api/tokens` | 5 minutes | 288 token publications |
| `/api/max-tracker` | 30 minutes | 48 Max Tracker publications |
| `/api/github` | 30 minutes | 48 GitHub publications |
| **Total** | | **384 publications** |

Two publishers can therefore make at most 768 publications per day. On the
healthy-success path, one continuously changing publisher makes 9,024 public
Worker requests and 9,024 Durable Object RPCs per day; two make 9,408 of each.
A failed publication leaves its send time unchanged and can retry on the next
30-second publisher check, so failed-attempt traffic is not bounded by those
healthy-success totals. A sustained failure can attempt each of the three POSTs
on every check until the relay accepts them.

With complete endpoint coverage, the bounded GET queries return at most 8,640
document rows per day for one publisher or 17,280 document rows for two. Eight
publishers is the hard upper bound, so neither storage nor reads can grow with
untrusted publisher names.

Every admitted publication changes two application-table rows: the monotonic
counter and one document. Cloudflare's
[SQLite billing rules](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
also count index maintenance as billed row writes. For a conservative ceiling,
allow a data row and its primary-key index row for each change: up to four
billed row writes per publication, plus up to two when a publisher is first
registered. These are conservative upper bounds, not exact billed-row counts.
The actual SQLite primary-key index rows updated depend on the statement and
table layout.

At the scheduled maximum, that budget remains under 1,600 billed row writes per
day for one publisher and under 3,100 billed row writes for two, including
their first registrations. Both are far below the SQLite Durable Object
100,000-row daily free limit (see Cloudflare's
[current pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
Schema initialization and internal metadata are small one-time costs, not part
of those daily publication estimates. These are SQLite operations, not KV
writes; the active path spends no KV operation quota.

## Setup and the two-stage lifecycle

The exact private configuration and guarded commands live in
[tools/relay/README.md](../tools/relay/README.md). The sequence matters because
Cloudflare cannot roll a Worker version backward across a Durable Object class
lifecycle creation.

1. Keep the existing real `VIBEPULSE` namespace and secret. Deploy
   `bootstrap.js` first with the local `NUMBERS_MAILBOX` binding and sole
   SQLite `NumbersMailbox` export. The class is created, but the public request
   path still uses the old KV data.
2. Verify the old public contract and capture the bootstrap version. This is
   the only emergency rollback target after class creation.
3. Change only the private config's `main` value and switch to `worker.js`.
   Run the guarded dry build before the guarded deployment.
4. The new Durable Object mailbox starts empty; restart each active tokenserver
   so its immediate first publish pass sends all three endpoints:
   `/api/tokens`, `/api/max-tracker`, and `/api/github`.

Never roll back directly to a pre-Durable-Object version. If the `worker.js`
stage fails, rollback only to the captured bootstrap version, which is already
on the created-class side of the lifecycle boundary. Bootstrap deliberately
restores the old KV list/get/put behavior, including its exhausted list-quota
failure mode. Do not delete or rewrite the retained KV data.

## Recovery checks

After activating `worker.js` and restarting publishers:

1. Confirm the local tokenserver reports `usage_http_200 + ok` and that its
   Claude fields are not stale.
2. Fetch all three secret cloud URLs and compare only the non-secret numeric
   fields with the local endpoints. Never print the secret URL in logs or a
   shared transcript.
3. Wait one panel polling interval (30 seconds) and confirm `STALE` clears on
   the glass while LAN failover is active.
4. If the mailbox returns 503, use the Worker's sanitized `publish` or `read`
   diagnostic. It intentionally contains no secret, publisher, body, or RPC
   error text.

### Repairing corrupt mailbox state

A corrupt document normally self-heals on that publisher's next valid
publication. Reads already isolate malformed document JSON, so restart the
affected tokenserver and check the three endpoints before touching storage.

If a bad row continues to block publications, use Cloudflare's official
[Durable Objects Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/).
It requires the Workers Platform Admin role. In the Cloudflare dashboard, open
the `NumbersMailbox` Durable Object namespace, start Data Studio, and identify
the single object by its unique name, `numbers-mailbox-v1`. Inspect the
`publishers`, `documents`, and `mailbox_state` tables, repair only the confirmed
corrupt row, then restart the affected tokenserver so valid values are
republished. Data Studio operates on the remote object, consumes normal usage,
and audit-logs its queries, so keep the change narrow and reviewed.

Do not delete the entire Durable Object or all mailbox rows. If scoped repair
is unsafe or the damage cannot be identified, use a reviewed fresh mailbox-name
rollout instead: change the deterministic mailbox name in reviewed code, deploy
the `worker.js` change through the guarded dry run and deployment, and restart
publishers to fill the new empty object. Preserve the old object until the
replacement is verified.

No firmware or OTA change is required for this storage repair. The public URLs
and response bodies remain unchanged.

## Operational decisions worth keeping

- The publisher identifies itself honestly as `vibepulse-publisher/1`; the
  separate Anthropic probe keeps its tested Claude CLI user agent.
- Change detection reduces ordinary traffic, but the endpoint ceilings above
  are the hard safety boundary. Tokens can publish at most every 5 minutes;
  Max Tracker and GitHub can publish at most every 30 minutes.
- The mailbox data is replaceable, but the Worker lifecycle is not disposable
  after class creation. Preserve the bootstrap version and retained KV data
  for as long as rollback to the old request path is required.
