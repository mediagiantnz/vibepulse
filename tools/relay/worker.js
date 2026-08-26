/*
 * VibePulse-brevlådan: en Cloudflare Worker + Durable Object som håller
 * tjänstens
 * senaste siffror så panelen kan hämta dem från vilket nät som helst.
 *
 * Rollen är medvetet dum: den kan ingenting, vet ingenting och har inga
 * nycklar. Tjänsten (tools/tokenserver --publish) POSTar färdiga JSON-
 * kroppar hit; panelen GETtar dem när LAN:et inte svarar. Det som ligger
 * här är SIFFROR — kvot, burn rate, Max Tracker, GitHub. Agentstatus och
 * Needs You publiceras aldrig (firmwarens test/test_relay_boundary.py och
 * tjänstens publisher.py håller den gränsen från var sitt håll).
 *
 * Åtkomstkontrollen ÄR sökvägen: /u/<hemlighet>/api/... där hemligheten
 * är minst 32 slumpade byte ur secrets.h (TK_VIBEPULSE_RELAY_URL). Samma
 * skyddsnivå som en privat delningslänk — rätt nivå för procentsiffror,
 * och skälet till att inget känsligare än siffror får bo här. Eftersom
 * URL:en är nyckeln jämförs den i konstant tid (guard.js), varje svar är
 * Cache-Control: no-store, och plattformens invocation logs (som sparar
 * URL:en i sju dagar) är avstängda i wrangler-konfigurationen.
 *
 * Flera avsändare (en Mac som sover, en alltid-på-PC) publicerar till
 * samma brevlåda under eget namn (maskinens korta värdnamn). Brevlådan
 * har åtta platser; en nionde avsändare knuffar ut den vars senaste
 * dokument är äldst, aldrig den som just publicerar. Läsningen slår ihop
 * dem:
 *
 *   /api/tokens      — färskast VINNER PER POOL: varje kvotpool bär redan
 *                      sin egen observationsstämpel
 *                      (claudeWeekObservedAt,
 *                      claudeModelWeekObservedAt, ... — byggda för
 *                      stalenesslogiken),
 *                      så Codex-siffran kan komma från Macen som körde
 *                      Codex senast medan Claude-siffran kommer från PC:n
 *                      som frågade Anthropic för tio sekunder sedan.
 *   /api/max-tracker — nyast mottagna dokument vinner helt. Historiken är
 *                      per maskin; en dag-för-dag-sammanslagning vore att
 *                      hitta på data ingen maskin har sett. Ärlig gräns:
 *                      kör du Max Tracker-historik från två maskiner är
 *                      det den senast publicerande som syns.
 *   /api/github      — nyast vinner. Båda frågar samma publika API.
 *
 * Deploy: se README.md i den här katalogen. Den gamla KV-bindningen behålls
 * bara för rollback; alla nya anrop går till NUMBERS_MAILBOX.
 */

import { DurableObject } from "cloudflare:workers";
import { mergeTokens, newestBody } from "./merge.js";
import {
  MAX_BODY_BYTES, bodyShapeProblem, jsonResponse, readNumbersBody,
  resolveEndpoint, textResponse, utf8ByteLength,
} from "./guard.js";

export { mergeTokens, newestBody };

const ENDPOINTS = ["/api/tokens", "/api/max-tracker", "/api/github"];
const MAX_PUBLISHERS = 8;
const PUBLISHER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAILBOX_NAME = "numbers-mailbox-v1";

export class NumbersMailbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS publishers (
            publisher TEXT PRIMARY KEY
              CHECK (length(publisher) BETWEEN 1 AND 64)
          );
          CREATE TABLE IF NOT EXISTS documents (
            endpoint TEXT NOT NULL,
            publisher TEXT NOT NULL,
            received_at REAL NOT NULL,
            body_json TEXT NOT NULL,
            PRIMARY KEY (endpoint, publisher),
            FOREIGN KEY (publisher) REFERENCES publishers(publisher)
          );
          CREATE TABLE IF NOT EXISTS mailbox_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            receipt_sequence INTEGER NOT NULL CHECK (receipt_sequence >= 0)
          );
        `);
        // If this code follows an earlier mailbox build, continue above its
        // largest receipt value so an upgrade cannot make new rows look old.
        ctx.storage.sql.exec(`
          INSERT OR IGNORE INTO mailbox_state (singleton, receipt_sequence)
          SELECT 1, COALESCE(CAST(MAX(received_at) AS INTEGER), 0)
          FROM documents
        `);
      });
    });
  }

  async publish(endpoint, publisher, bodyJson) {
    assertEndpoint(endpoint);
    if (typeof publisher !== "string" ||
        !PUBLISHER_PATTERN.test(publisher))
      throw new RangeError("invalid publisher");
    if (typeof bodyJson !== "string" ||
        utf8ByteLength(bodyJson) > MAX_BODY_BYTES)
      throw new RangeError("invalid body");
    const body = JSON.parse(bodyJson);
    if (bodyShapeProblem(body) !== null)
      throw new RangeError("invalid body");
    // A publisher's clock is not trusted past the moment of receipt: a fast
    // clock would otherwise win every pool for as long as it stays ahead.
    // Older stamps are kept as claimed (a republished stale cache keeps its
    // original observation time).
    const storedJson = clampObservedAt(body, bodyJson, Date.now() / 1000);

    return this.ctx.storage.transactionSync(() => {
      const registered = this.ctx.storage.sql.exec(`
        SELECT 1 AS present FROM publishers WHERE publisher = ? LIMIT 1
      `, publisher).toArray()[0] !== undefined;
      if (!registered) {
        const count = this.ctx.storage.sql.exec(
          "SELECT COUNT(*) AS count FROM publishers",
        ).one().count;
        if (count >= MAX_PUBLISHERS) this.evictQuietest();
        this.ctx.storage.sql.exec(
          "INSERT INTO publishers (publisher) VALUES (?)", publisher,
        );
      }

      const receivedAt = this.ctx.storage.sql.exec(`
        UPDATE mailbox_state
        SET receipt_sequence = receipt_sequence + 1
        WHERE singleton = 1
        RETURNING receipt_sequence
      `).one().receipt_sequence;

      this.ctx.storage.sql.exec(`
        INSERT INTO documents (endpoint, publisher, received_at, body_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(endpoint, publisher) DO UPDATE SET
          received_at = excluded.received_at,
          body_json = excluded.body_json
      `, endpoint, publisher, receivedAt, storedJson);
      return "stored";
    });
  }

  // Runs inside publish's transaction, only for an unregistered publisher,
  // so the arriving name can never be the one removed. The evicted name is
  // the registered publisher whose newest document is oldest; a name with
  // no document at all (should not happen: registration and its document
  // commit together) is removed first.
  evictQuietest() {
    const quietest = this.ctx.storage.sql.exec(`
      SELECT p.publisher AS publisher, MAX(d.received_at) AS newest
      FROM publishers AS p
      LEFT JOIN documents AS d ON d.publisher = p.publisher
      GROUP BY p.publisher
      ORDER BY newest ASC, p.publisher ASC
      LIMIT 1
    `).toArray()[0];
    if (quietest === undefined) return;
    this.ctx.storage.sql.exec(
      "DELETE FROM documents WHERE publisher = ?", quietest.publisher,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM publishers WHERE publisher = ?", quietest.publisher,
    );
  }

  async getDocs(endpoint) {
    assertEndpoint(endpoint);
    const rows = this.ctx.storage.sql.exec(`
      SELECT publisher, received_at, body_json
      FROM documents
      WHERE endpoint = ?
      ORDER BY publisher
      LIMIT ?
    `, endpoint, MAX_PUBLISHERS).toArray();
    const docs = [];
    for (const row of rows) {
      if (typeof row.publisher !== "string" ||
          !PUBLISHER_PATTERN.test(row.publisher) ||
          typeof row.received_at !== "number" ||
          !Number.isFinite(row.received_at) ||
          typeof row.body_json !== "string")
        continue;
      try {
        docs.push({
          receivedAt: row.received_at,
          publisher: row.publisher,
          body: JSON.parse(row.body_json),
        });
      } catch {
        /* ett korrupt dokument tystar inte de andra */
      }
    }
    return docs;
  }
}

function clampObservedAt(body, bodyJson, receivedWall) {
  let clamped = false;
  for (const key of Object.keys(body)) {
    const value = body[key];
    if (key.endsWith("ObservedAt") && typeof value === "number" &&
        value > receivedWall) {
      body[key] = receivedWall;
      clamped = true;
    }
  }
  // Unchanged documents keep the publisher's exact bytes.
  return clamped ? JSON.stringify(body) : bodyJson;
}

function assertEndpoint(endpoint) {
  if (!ENDPOINTS.includes(endpoint)) throw new RangeError("invalid endpoint");
}

function mailbox(env) {
  if (!env.NUMBERS_MAILBOX ||
      typeof env.NUMBERS_MAILBOX.getByName !== "function")
    throw new Error("mailbox unavailable");
  return env.NUMBERS_MAILBOX.getByName(MAILBOX_NAME);
}

function logMailboxFailure(operation) {
  // Never attach the thrown error: RPC errors can contain request-derived
  // strings. The operation is enough to distinguish write/read failures.
  console.error(JSON.stringify({
    level: "error",
    event: "numbers_mailbox_failure",
    operation,
  }));
}

export default {
  async fetch(request, env) {
    // Hemligheten är en Worker-secret (wrangler secret put RELAY_SECRET),
    // aldrig kod. Utan den svarar brevlådan ingenting alls.
    const secret = env.RELAY_SECRET;
    if (!secret || secret.length < 32)
      return textResponse("relay not configured", 503);

    const endpoint = await resolveEndpoint(request.url, secret, ENDPOINTS);
    if (endpoint === null) return textResponse("not found", 404);

    if (request.method === "POST" || request.method === "PUT") {
      const publisher =
          (request.headers.get("X-VibePulse-Publisher") || "unnamed")
              .slice(0, 64).replace(/[^A-Za-z0-9._-]/g, "_");
      const read = await readNumbersBody(request);
      if (read.response !== undefined) return read.response;
      let result;
      try {
        result = await mailbox(env).publish(endpoint, publisher, read.raw);
      } catch {
        logMailboxFailure("publish");
        return textResponse("relay unavailable", 503);
      }
      // The mailbox now evicts instead of refusing, but the strict answer
      // stays mapped so an older mailbox build cannot turn into a 503.
      if (result === "full")
        return textResponse("too many publishers", 409);
      if (result !== "stored") {
        logMailboxFailure("publish");
        return textResponse("relay unavailable", 503);
      }
      return textResponse("ok", 200);
    }

    if (request.method === "GET") {
      let docs;
      try {
        docs = await mailbox(env).getDocs(endpoint);
      } catch {
        logMailboxFailure("read");
        return textResponse("relay unavailable", 503);
      }
      const merged = endpoint === "/api/tokens" ? mergeTokens(docs)
                                                : newestBody(docs);
      if (merged === null) return jsonResponse({ error: "no data yet" }, 404);
      return jsonResponse(merged);
    }

    return textResponse("method not allowed", 405);
  },
};
