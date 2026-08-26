import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { NumbersMailbox, mergeTokens } from "./worker.js";
import rawConfig from "./wrangler.test.jsonc?raw";
import {
  realGithubDocument, realMaxTrackerDocument, realTokensDocument,
} from "./fixtures.mjs";

const SECRET = "s".repeat(64);
const MAILBOX_NAME = "numbers-mailbox-v1";
let mailboxSequence = 0;

afterEach(() => vi.restoreAllMocks());

function mailbox() {
  mailboxSequence += 1;
  return env.NUMBERS_MAILBOX.getByName(`test-mailbox-${mailboxSequence}`);
}

function relayRequest(requestEnv, endpoint, {
  method = "GET", publisher, body, urlSecret = SECRET,
} = {}) {
  const headers = new Headers();
  if (publisher !== undefined)
    headers.set("X-VibePulse-Publisher", publisher);
  const init = { method, headers };
  if (body !== undefined)
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  const request = new Request(
      `https://relay.test/u/${urlSecret}${endpoint}`, init);
  return worker.fetch(request, requestEnv);
}

function fakeEnv({
  docs = [], publishResult = "stored", namespaceError = null,
  rpcError = null, includeBinding = true,
} = {}) {
  const calls = { names: [], publish: [], getDocs: [], kv: [] };
  const stub = {
    async publish(...args) {
      calls.publish.push(args);
      if (rpcError !== null) throw rpcError;
      return publishResult;
    },
    async getDocs(...args) {
      calls.getDocs.push(args);
      if (rpcError !== null) throw rpcError;
      return docs;
    },
  };
  const namespace = {
    getByName(name) {
      calls.names.push(name);
      if (namespaceError !== null) throw namespaceError;
      return stub;
    },
  };
  const VIBEPULSE = new Proxy({}, {
    get(_target, property) {
      calls.kv.push(String(property));
      throw new Error("KV request path operation must never occur");
    },
  });
  const requestEnv = { RELAY_SECRET: SECRET, VIBEPULSE };
  if (includeBinding) requestEnv.NUMBERS_MAILBOX = namespace;
  return { calls, requestEnv };
}

// RangeErrors thrown across the RPC boundary surface as unhandled DO-side
// rejections in the test harness, so invalid publishes are attempted inside
// the object and reported as a boolean.
async function publishRejected(stub, endpoint, publisher, bodyJson) {
  return runInDurableObject(stub, async (instance) => {
    try {
      await instance.publish(endpoint, publisher, bodyJson);
      return false;
    } catch (error) {
      return error instanceof RangeError;
    }
  });
}

async function storedState(stub) {
  return runInDurableObject(stub, async (_instance, state) => ({
    publishers: state.storage.sql.exec(
      "SELECT publisher FROM publishers ORDER BY publisher",
    ).toArray().map((row) => row.publisher),
    documents: state.storage.sql.exec(`
      SELECT endpoint, publisher, received_at, body_json
      FROM documents ORDER BY endpoint, publisher
    `).toArray(),
  }));
}

describe("NumbersMailbox SQLite coordination", () => {
  it("registers eight simultaneous first publishers without losing peers",
     async () => {
    const stub = mailbox();
    const publishers = Array.from({ length: 8 }, (_, index) => `p${index}`);
    const results = await Promise.all(publishers.map((publisher, index) =>
      stub.publish(
        "/api/tokens", publisher,
        JSON.stringify({ publisher, value: index }),
      )));

    expect(results).toEqual(Array(8).fill("stored"));
    const state = await storedState(stub);
    expect(state.publishers).toEqual(publishers);
    expect(state.documents).toHaveLength(8);
  });

  it("evicts the longest-silent publisher when a ninth name arrives",
     async () => {
    const stub = mailbox();
    const firstEight = Array.from({ length: 8 }, (_, index) => `p${index}`);
    for (const publisher of firstEight) {
      await expect(stub.publish(
        "/api/tokens", publisher, JSON.stringify({ publisher }),
      )).resolves.toBe("stored");
    }
    // p0 was registered first but publishes again, so p1 is now the
    // publisher whose newest document is oldest.
    await expect(stub.publish(
      "/api/github", "p0", JSON.stringify({ stars: 99 }),
    )).resolves.toBe("stored");

    await expect(stub.publish(
      "/api/tokens", "p8", JSON.stringify({ publisher: "p8" }),
    )).resolves.toBe("stored");

    const state = await storedState(stub);
    expect(state.publishers).toEqual(
      ["p0", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
    expect(state.documents.some((row) => row.publisher === "p1")).toBe(false);
    expect(state.documents).toContainEqual(expect.objectContaining({
      endpoint: "/api/tokens", publisher: "p8",
    }));
    expect(state.documents).toContainEqual(expect.objectContaining({
      endpoint: "/api/github", publisher: "p0",
    }));
    await expect(stub.getDocs("/api/tokens")).resolves.toHaveLength(8);
  });

  it("never evicts the publisher that is publishing and keeps eight names",
     async () => {
    const stub = mailbox();
    for (let index = 0; index < 8; index += 1)
      await stub.publish("/api/tokens", `p${index}`, JSON.stringify({ index }));
    // Twelve more distinct names: each arrival evicts exactly one other name
    // and the arriving name is always present afterwards.
    for (let index = 8; index < 20; index += 1) {
      const name = `late${index}`;
      await expect(stub.publish(
        "/api/max-tracker", name, JSON.stringify({ index }),
      )).resolves.toBe("stored");
      const state = await storedState(stub);
      expect(state.publishers).toHaveLength(8);
      expect(state.publishers).toContain(name);
      expect(state.documents.filter((row) => row.publisher === name))
        .toHaveLength(1);
    }
    // A registered publisher's publish never evicts anybody.
    const before = (await storedState(stub)).publishers;
    await stub.publish("/api/github", before[0], JSON.stringify({ stars: 1 }));
    expect((await storedState(stub)).publishers).toEqual(before);
  });

  it("evicts a registered name that somehow has no documents first",
     async () => {
    const stub = mailbox();
    for (let index = 0; index < 7; index += 1)
      await stub.publish("/api/tokens", `p${index}`, JSON.stringify({ index }));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO publishers (publisher) VALUES (?)", "ghost",
      );
    });
    await expect(stub.publish(
      "/api/tokens", "p7", JSON.stringify({ index: 7 }),
    )).resolves.toBe("stored");
    const state = await storedState(stub);
    expect(state.publishers).not.toContain("ghost");
    expect(state.publishers).toContain("p0");
    expect(state.publishers).toContain("p7");
  });

  it("clamps every claimed *ObservedAt to the receipt wall clock", async () => {
    const stub = mailbox();
    const before = Date.now() / 1000;
    const future = before + 10 * 24 * 3600;
    await stub.publish("/api/tokens", "fastclock", JSON.stringify({
      v: 2, claudeWeekPct: 73, claudeWeekObservedAt: future,
      codexWeekPct: 41, codexWeekObservedAt: future,
      codexWeekStale: false, nested: { claudeWeekObservedAt: future },
      claudeWeekObservedAtLabel: "not a stamp",
    }));
    const after = Date.now() / 1000;
    const [doc] = await stub.getDocs("/api/tokens");
    expect(doc.body.claudeWeekObservedAt).toBeGreaterThanOrEqual(before);
    expect(doc.body.claudeWeekObservedAt).toBeLessThanOrEqual(after);
    expect(doc.body.codexWeekObservedAt).toBeGreaterThanOrEqual(before);
    expect(doc.body.codexWeekObservedAt).toBeLessThanOrEqual(after);
    // Only top-level stamps are clamped; other fields are stored untouched.
    expect(doc.body.nested).toEqual({ claudeWeekObservedAt: future });
    expect(doc.body.claudeWeekObservedAtLabel).toBe("not a stamp");
    expect(doc.body.claudeWeekPct).toBe(73);
    expect(doc.body.codexWeekStale).toBe(false);
  });

  it("keeps an honest older *ObservedAt untouched (republished stale cache)",
     async () => {
    const stub = mailbox();
    const body = { v: 2, claudeWeekPct: 70, claudeWeekStale: true,
                   claudeWeekObservedAt: 1700000000, codexWeekObservedAt: null };
    await stub.publish("/api/tokens", "mac", JSON.stringify(body));
    const state = await storedState(stub);
    expect(state.documents[0].body_json).toBe(JSON.stringify(body));
    const [doc] = await stub.getDocs("/api/tokens");
    expect(doc.body).toEqual(body);
  });

  it("lets a clamped fast clock lose to a genuinely newer reading", async () => {
    const stub = mailbox();
    const now = Date.now() / 1000;
    await stub.publish("/api/tokens", "fast", JSON.stringify({
      v: 2, claudeWeekPct: 10, claudeWeekObservedAt: now + 365 * 24 * 3600,
    }));
    // The honest publisher observes a little later in wall time than the
    // clamped receipt, so it must win.
    await new Promise((resolveWait) => setTimeout(resolveWait, 15));
    const honestAt = Date.now() / 1000;
    await stub.publish("/api/tokens", "honest", JSON.stringify({
      v: 2, claudeWeekPct: 90, claudeWeekObservedAt: honestAt,
    }));
    const docs = await stub.getDocs("/api/tokens");
    const fast = docs.find((doc) => doc.publisher === "fast");
    expect(fast.body.claudeWeekObservedAt).toBeLessThan(honestAt);
    const merged = mergeTokens(docs);
    expect(merged.claudeWeekPct).toBe(90);
  });

  it("measures the mailbox body limit in UTF-8 bytes", async () => {
    const stub = mailbox();
    // 22,000 three-byte characters: 22,000 UTF-16 units but 66,000 bytes.
    const wide = JSON.stringify({ note: "\u20ac".repeat(22_000) });
    expect(wide.length).toBeLessThan(64 * 1024);
    expect(await publishRejected(stub, "/api/tokens", "mac", wide)).toBe(true);
    expect((await storedState(stub)).documents).toEqual([]);
  });

  it("refuses documents whose shape no honest publisher sends", async () => {
    const stub = mailbox();
    for (const body of [
      { deep: { a: { b: { c: { d: 1 } } } } }, { prose: "x".repeat(2000) },
      [1, 2],
    ])
      expect(await publishRejected(
        stub, "/api/tokens", "mac", JSON.stringify(body),
      )).toBe(true);
    expect((await storedState(stub)).documents).toEqual([]);
  });

  it("commits publisher registration and its endpoint document together",
     async () => {
    const stub = mailbox();
    await expect(stub.publish(
      "/api/tokens", "mac", JSON.stringify({ weekPct: 73 }),
    )).resolves.toBe("stored");

    const state = await storedState(stub);
    expect(state.publishers).toEqual(["mac"]);
    expect(state.documents).toEqual([expect.objectContaining({
      endpoint: "/api/tokens",
      publisher: "mac",
      received_at: 1,
      body_json: JSON.stringify({ weekPct: 73 }),
    })]);
  });

  it("rolls registration back when document storage fails", async () => {
    const stub = mailbox();
    await stub.getDocs("/api/tokens");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_document_insert
        BEFORE INSERT ON documents
        BEGIN
          SELECT RAISE(ABORT, 'forced document failure');
        END
      `);
    });

    const failed = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.publish(
          "/api/tokens", "mac", JSON.stringify({ weekPct: 73 }),
        );
        return false;
      } catch {
        return true;
      }
    });
    expect(failed).toBe(true);
    const state = await storedState(stub);
    expect(state.publishers).toEqual([]);
    expect(state.documents).toEqual([]);
    await runInDurableObject(stub, async (_instance, objectState) => {
      expect(objectState.storage.sql.exec(`
        SELECT receipt_sequence FROM mailbox_state WHERE singleton = 1
      `).one().receipt_sequence).toBe(0);
      objectState.storage.sql.exec("DROP TRIGGER fail_document_insert");
    });
    await expect(stub.publish(
      "/api/tokens", "pc", JSON.stringify({ weekPct: 74 }),
    )).resolves.toBe("stored");
    await expect(stub.getDocs("/api/tokens")).resolves.toEqual([{
      receivedAt: 1,
      publisher: "pc",
      body: { weekPct: 74 },
    }]);
  });

  it("skips a corrupt row without hiding a healthy publisher", async () => {
    const stub = mailbox();
    await stub.publish(
      "/api/github", "healthy", JSON.stringify({ stars: 99 }),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO publishers (publisher) VALUES (?)", "broken",
      );
      state.storage.sql.exec(`
        INSERT INTO documents (endpoint, publisher, received_at, body_json)
        VALUES (?, ?, ?, ?)
      `, "/api/github", "broken", 200, "not-json");
    });

    await expect(stub.getDocs("/api/github")).resolves.toEqual([{
      receivedAt: 1,
      publisher: "healthy",
      body: { stars: 99 },
    }]);
  });

  it("returns no documents when every stored row is corrupt", async () => {
    const stub = mailbox();
    await stub.getDocs("/api/github");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO publishers (publisher) VALUES (?)", "broken",
      );
      state.storage.sql.exec(`
        INSERT INTO documents (endpoint, publisher, received_at, body_json)
        VALUES (?, ?, ?, ?)
      `, "/api/github", "broken", 200, "not-json");
    });

    await expect(stub.getDocs("/api/github")).resolves.toEqual([]);
  });

  it("owns receipt ordering even when direct RPC callers add timestamps",
     async () => {
    const stub = mailbox();
    await stub.publish(
      "/api/github", "mac", JSON.stringify({ source: "first" }),
      Number.MAX_SAFE_INTEGER,
    );
    await stub.publish(
      "/api/github", "pc", JSON.stringify({ source: "second" }), -1,
    );

    const docs = await stub.getDocs("/api/github");
    expect(docs.map((doc) => doc.receivedAt).sort()).toEqual([1, 2]);
    expect(docs.find((doc) => doc.publisher === "pc").body).toEqual({
      source: "second",
    });
  });

  it("keeps the later same-publisher body regardless of extra RPC input",
     async () => {
    const stub = mailbox();
    await stub.publish(
      "/api/max-tracker", "mac", JSON.stringify({ value: "old" }), 999999,
    );
    await stub.publish(
      "/api/max-tracker", "mac", JSON.stringify({ value: "new" }), 0,
    );

    await expect(stub.getDocs("/api/max-tracker")).resolves.toEqual([{
      receivedAt: 2,
      publisher: "mac",
      body: { value: "new" },
    }]);
  });
});

describe("public numbers Worker routing and wire contract", () => {
  for (const [endpoint, body] of [
    ["/api/tokens", { v: 2, weekPct: 73, weekObservedAt: 100 }],
    ["/api/max-tracker", { streak: 4, total: 12 }],
    ["/api/github", { stars: 99, issues: 3 }],
  ]) {
    it(`round-trips the first real publication for ${endpoint}`, async () => {
      const posted = await relayRequest(env, endpoint, {
        method: "POST", publisher: "mac", body,
      });
      expect(posted.status).toBe(200);
      expect(await posted.text()).toBe("ok");
      expect(posted.headers.get("Cache-Control")).toBe("no-store");

      const fetched = await relayRequest(env, endpoint);
      expect(fetched.status).toBe(200);
      expect(await fetched.json()).toEqual(body);
      expect(fetched.headers.get("Content-Type")).toBe("application/json");
      expect(fetched.headers.get("Cache-Control")).toBe("no-store");
    });
  }

  for (const [endpoint, document] of [
    ["/api/tokens", realTokensDocument()],
    ["/api/max-tracker", realMaxTrackerDocument()],
    ["/api/github", realGithubDocument()],
  ]) {
    it(`accepts the real worst-case ${endpoint} document end to end`,
       async () => {
      const stub = mailbox();
      const requestEnv = {
        RELAY_SECRET: SECRET,
        NUMBERS_MAILBOX: { getByName: () => stub },
        VIBEPULSE: env.VIBEPULSE,
      };
      const posted = await relayRequest(requestEnv, endpoint, {
        method: "POST", publisher: "real-host", body: document,
      });
      expect(posted.status).toBe(200);
      const fetched = await relayRequest(requestEnv, endpoint);
      expect(fetched.status).toBe(200);
      const merged = await fetched.json();
      // Publisher stamps in the fixture are in the past, so nothing clamps.
      expect(merged).toEqual(document);
    });
  }

  it("marks every response no-store, including errors", async () => {
    const { requestEnv } = fakeEnv({ publishResult: "full" });
    const unconfigured = { ...requestEnv, RELAY_SECRET: "short" };
    const responses = await Promise.all([
      relayRequest(unconfigured, "/api/tokens"),
      relayRequest(requestEnv, "/api/tokens", { urlSecret: "x".repeat(64) }),
      relayRequest(requestEnv, "/api/tokens", { method: "DELETE" }),
      relayRequest(requestEnv, "/api/tokens", {
        method: "POST", publisher: "mac", body: "{not-json",
      }),
      relayRequest(requestEnv, "/api/tokens", {
        method: "POST", publisher: "mac", body: "x".repeat(64 * 1024 + 1),
      }),
      relayRequest(requestEnv, "/api/tokens", {
        method: "POST", publisher: "mac", body: { weekPct: 73 },
      }),
      relayRequest(fakeEnv().requestEnv, "/api/tokens"),
    ]);
    expect(responses.map((response) => response.status))
      .toEqual([503, 404, 405, 400, 413, 409, 404]);
    for (const response of responses)
      expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects oversize bytes, bad UTF-8 and dishonest shapes before the RPC",
     async () => {
    const { calls, requestEnv } = fakeEnv();
    // 22,000 euro signs are under 64 Ki UTF-16 units but over 64 KiB.
    const wide = await relayRequest(requestEnv, "/api/tokens", {
      method: "POST", publisher: "mac",
      body: JSON.stringify({ note: "\u20ac".repeat(22_000) }),
    });
    expect(wide.status).toBe(413);
    const badUtf8 = await worker.fetch(new Request(
      `https://relay.test/u/${SECRET}/api/tokens`,
      { method: "POST", body: new Uint8Array([0x7b, 0xff, 0x7d]) },
    ), requestEnv);
    expect(badUtf8.status).toBe(400);
    for (const body of [
      [1, 2, 3], { prose: "x".repeat(400) },
      { a: { b: { c: { d: { e: 1 } } } } }, { "bad key!": 1 },
    ]) {
      const response = await relayRequest(requestEnv, "/api/tokens", {
        method: "POST", publisher: "mac", body,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("bad shape");
    }
    expect(calls.publish).toEqual([]);
    expect(calls.kv).toEqual([]);
  });

  it("routes every valid request to one deterministic mailbox without KV",
     async () => {
    const { calls, requestEnv } = fakeEnv({
      docs: [{ receivedAt: 100, publisher: "mac", body: { stars: 99 } }],
    });
    const posted = await relayRequest(requestEnv, "/api/tokens", {
      method: "POST", publisher: "mac", body: { weekPct: 73 },
    });
    const fetched = await relayRequest(requestEnv, "/api/github");

    expect(posted.status).toBe(200);
    expect(fetched.status).toBe(200);
    expect(calls.names).toEqual([MAILBOX_NAME, MAILBOX_NAME]);
    expect(calls.publish).toHaveLength(1);
    expect(calls.getDocs).toEqual([["/api/github"]]);
    expect(calls.kv).toEqual([]);
  });

  it("keeps 100 repeated GETs free of every KV request operation", async () => {
    const { calls, requestEnv } = fakeEnv({
      docs: [{ receivedAt: 100, publisher: "mac", body: { weekPct: 73 } }],
    });
    for (let index = 0; index < 100; index += 1) {
      const response = await relayRequest(requestEnv, "/api/tokens");
      expect(response.status).toBe(200);
    }
    expect(calls.names).toEqual(Array(100).fill(MAILBOX_NAME));
    expect(calls.kv).toEqual([]);
  });

  it("keeps wrong secrets and the activity endpoint hidden behind 404",
     async () => {
    const { calls, requestEnv } = fakeEnv();
    const wrongSecret = await relayRequest(requestEnv, "/api/tokens", {
      urlSecret: "x".repeat(64),
    });
    const activity = await relayRequest(requestEnv, "/api/agent-status");

    expect(wrongSecret.status).toBe(404);
    expect(activity.status).toBe(404);
    expect(calls.names).toEqual([]);
    expect(calls.kv).toEqual([]);
  });

  it("preserves missing-secret, method, body-size, and JSON responses",
     async () => {
    const configured = fakeEnv();
    const unconfigured = { ...configured.requestEnv, RELAY_SECRET: "short" };
    expect((await relayRequest(unconfigured, "/api/tokens")).status).toBe(503);
    expect(await (await relayRequest(
      configured.requestEnv, "/api/tokens", { method: "DELETE" },
    )).text()).toBe("method not allowed");
    expect((await relayRequest(configured.requestEnv, "/api/tokens", {
      method: "POST", publisher: "mac", body: "x".repeat(64 * 1024 + 1),
    })).status).toBe(413);
    expect((await relayRequest(configured.requestEnv, "/api/tokens", {
      method: "POST", publisher: "mac", body: "{not-json",
    })).status).toBe(400);
    expect(configured.calls.names).toEqual([]);
    expect(configured.calls.kv).toEqual([]);
  });

  it("sanitizes publishers before the mailbox RPC and preserves POST output",
     async () => {
    const { calls, requestEnv } = fakeEnv();
    const rawPublisher = `mac name/with?unsafe#chars-${"x".repeat(80)}`;
    const expected = rawPublisher.slice(0, 64)
      .replace(/[^A-Za-z0-9._-]/g, "_");
    const response = await relayRequest(requestEnv, "/api/tokens", {
      method: "POST", publisher: rawPublisher, body: { weekPct: 73 },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(calls.publish).toHaveLength(1);
    expect(calls.publish[0][0]).toBe("/api/tokens");
    expect(calls.publish[0][1]).toBe(expected);
    expect(JSON.parse(calls.publish[0][2])).toEqual({ weekPct: 73 });
    expect(calls.publish[0]).toHaveLength(3);
    expect(calls.kv).toEqual([]);
  });

  it("maps mailbox capacity to the existing strict 409 response", async () => {
    const { requestEnv } = fakeEnv({ publishResult: "full" });
    const response = await relayRequest(requestEnv, "/api/tokens", {
      method: "POST", publisher: "ninth", body: { weekPct: 73 },
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("too many publishers");
  });

  it("fails closed when the mailbox binding is missing or broken", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = fakeEnv({ includeBinding: false });
    const missingResponse = await relayRequest(
      missing.requestEnv, "/api/tokens",
    );
    expect(missingResponse.status).toBe(503);
    expect(await missingResponse.text()).toBe("relay unavailable");

    const broken = fakeEnv({ namespaceError: new Error("binding detail") });
    const brokenResponse = await relayRequest(
      broken.requestEnv, "/api/tokens",
    );
    expect(brokenResponse.status).toBe(503);
    const brokenBody = await brokenResponse.text();
    expect(brokenBody).toBe("relay unavailable");
    expect(brokenBody).not.toContain("binding detail");
    expect(diagnostic).toHaveBeenCalledTimes(2);
    for (const call of diagnostic.mock.calls)
      expect(JSON.parse(String(call[0]))).toEqual({
        level: "error",
        event: "numbers_mailbox_failure",
        operation: "read",
      });
  });

  it("turns storage RPC errors into a non-leaking non-success response",
     async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitivePublisher = "private-mac";
    const sensitiveBody = "body-must-not-leak";
    const { requestEnv } = fakeEnv({
      rpcError: new Error(
        `${SECRET}:${sensitivePublisher}:${sensitiveBody}`,
      ),
    });
    const response = await relayRequest(requestEnv, "/api/tokens", {
      method: "POST", publisher: sensitivePublisher,
      body: { note: sensitiveBody, weekPct: 73 },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("relay unavailable");
    expect(diagnostic).toHaveBeenCalledTimes(1);
    const logged = String(diagnostic.mock.calls[0][0]);
    expect(JSON.parse(logged)).toEqual({
      level: "error",
      event: "numbers_mailbox_failure",
      operation: "publish",
    });
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(sensitivePublisher);
    expect(logged).not.toContain(sensitiveBody);
    diagnostic.mockRestore();
  });

  it("preserves per-pool token merging across real mailbox publishers",
     async () => {
    const stub = env.NUMBERS_MAILBOX.getByName(MAILBOX_NAME);
    await stub.publish("/api/tokens", "mac", JSON.stringify({
      v: 2,
      claudeWeekPct: 70, claudeWeekStale: true,
      claudeWeekObservedAt: 150,
      codexWeekPct: 41, codexWeekObservedAt: 190,
    }));
    await stub.publish("/api/tokens", "pc", JSON.stringify({
      v: 2,
      claudeWeekPct: 73, claudeWeekStale: false,
      claudeWeekObservedAt: 205,
      codexWeekPct: 39, codexWeekObservedAt: 100,
    }));

    const response = await relayRequest(env, "/api/tokens");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      claudeWeekPct: 73,
      claudeWeekStale: false,
      claudeWeekObservedAt: 205,
      codexWeekPct: 41,
      codexWeekObservedAt: 190,
    });
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  for (const endpoint of ["/api/max-tracker", "/api/github"]) {
    it(`preserves newest whole-document behavior for ${endpoint}`,
       async () => {
      const stub = mailbox();
      await stub.publish(
        endpoint, "mac", JSON.stringify({ source: "mac", value: 1 }),
      );
      await stub.publish(
        endpoint, "pc", JSON.stringify({ source: "pc", value: 2 }),
      );
      const requestEnv = {
        RELAY_SECRET: SECRET,
        NUMBERS_MAILBOX: { getByName: () => stub },
        VIBEPULSE: env.VIBEPULSE,
      };

      const response = await relayRequest(requestEnv, endpoint);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ source: "pc", value: 2 });
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });
  }

  it("preserves the existing JSON 404 for missing or corrupt rows", async () => {
    const stub = mailbox();
    await stub.getDocs("/api/github");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO publishers (publisher) VALUES (?)", "broken",
      );
      state.storage.sql.exec(`
        INSERT INTO documents (endpoint, publisher, received_at, body_json)
        VALUES (?, ?, ?, ?)
      `, "/api/github", "broken", 200, "not-json");
    });
    const requestEnv = {
      RELAY_SECRET: SECRET,
      NUMBERS_MAILBOX: { getByName: () => stub },
      VIBEPULSE: env.VIBEPULSE,
    };

    const response = await relayRequest(requestEnv, "/api/github");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no data yet" });
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("rollback-compatible KV bootstrap", () => {
  it("exports the mailbox class while preserving the old public KV contract",
     async () => {
    const bootstrap = await import("./bootstrap.js");
    expect(bootstrap.NumbersMailbox).toBe(NumbersMailbox);

    const publisher = "bootstrap-mac";
    const body = { stars: 99, issues: 3 };
    const url = `https://relay.test/u/${SECRET}/api/github`;
    const posted = await bootstrap.default.fetch(new Request(url, {
      method: "POST",
      headers: { "X-VibePulse-Publisher": publisher },
      body: JSON.stringify(body),
    }), env);
    expect(posted.status).toBe(200);
    expect(await posted.text()).toBe("ok");

    const stored = JSON.parse(
      await env.VIBEPULSE.get(`/api/github:${publisher}`),
    );
    expect(stored.publisher).toBe(publisher);
    expect(stored.body).toEqual(body);
    expect(stored.receivedAt).toEqual(expect.any(Number));

    const fetched = await bootstrap.default.fetch(new Request(url), env);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(body);
    expect(fetched.headers.get("Content-Type")).toBe("application/json");
    expect(posted.headers.get("Cache-Control")).toBe("no-store");
    expect(fetched.headers.get("Cache-Control")).toBe("no-store");
    const wrong = await bootstrap.default.fetch(new Request(
      `https://relay.test/u/${"x".repeat(64)}/api/github`), env);
    expect(wrong.status).toBe(404);
    expect(wrong.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("Wrangler Durable Object configuration", () => {
  it("retains KV only for rollback and declares one SQLite mailbox export", () => {
    const config = JSON.parse(rawConfig);
    expect(config.name).toBe("vibepulse-relay-bootstrap-test");
    expect(config.main).toBe("bootstrap.js");
    expect(config.compatibility_date).toBe("2026-08-22");
    expect(config.durable_objects).toEqual({
      bindings: [{
        name: "NUMBERS_MAILBOX",
        class_name: "NumbersMailbox",
      }],
    });
    expect(config.exports).toEqual({
      NumbersMailbox: { type: "durable-object", storage: "sqlite" },
    });
    expect(config.kv_namespaces).toEqual([expect.objectContaining({
      binding: "VIBEPULSE",
    })]);
    expect(config.secrets).toEqual({ required: ["RELAY_SECRET"] });
    expect(config).not.toHaveProperty("migrations");
  });

  it("keeps platform invocation logs off because the URL is the credential",
     () => {
    const config = JSON.parse(rawConfig);
    expect(config.observability).toEqual({
      enabled: true,
      logs: { invocation_logs: false },
    });
  });
});
