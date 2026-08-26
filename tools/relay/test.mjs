/*
 * Brevlådans sammanslagning, hållen stilla med node --test (ingen
 * Cloudflare behövs): färskast vinner PER POOL för /api/tokens, nyast
 * dokument för resten, och döda/korrupta dokument tystar aldrig de andra.
 *
 * Körs av test/run.sh när node finns; CI:s numbers-relay-jobb kör den via
 * "node --test tools/relay/".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeTokens, newestBody } from "./merge.js";
import {
  MAX_BODY_BYTES, MAX_STRING_CHARS, bodyShapeProblem, resolveEndpoint,
  utf8ByteLength,
} from "./guard.js";
import {
  realGithubDocument, realMaxTrackerDocument, realTokensDocument,
} from "./fixtures.mjs";

test("en ensam avsändare passerar orörd", () => {
  const doc = { receivedAt: 100, publisher: "mac",
                body: { v: 2, weekPct: 73, weekObservedAt: 90 } };
  assert.deepEqual(mergeTokens([doc]), doc.body);
});

test("varje pool tas från den maskin som såg den senast", () => {
  const mac = { receivedAt: 200, publisher: "mac", body: {
    v: 2,
    claudeWeekPct: 70, claudeWeekStale: true,
    claudeWeekObservedAt: 150,               // äldre Claude-observation
    codexWeekPct: 41, codexWeekObservedAt: 190,  // färsk Codex (Macen kör Codex)
  } };
  const pc = { receivedAt: 210, publisher: "pc", body: {
    v: 2,
    claudeWeekPct: 73, claudeWeekStale: false,
    claudeWeekObservedAt: 205,               // färsk Claude (PC:n frågade nyss)
    codexWeekPct: 39, codexWeekObservedAt: 100,  // gammal Codex
  } };
  const merged = mergeTokens([mac, pc]);
  assert.equal(merged.claudeWeekPct, 73, "Claude ska komma från PC:n");
  assert.equal(merged.claudeWeekStale, false,
               "PC:ns färska Claude-status ska följa poolen");
  assert.equal(merged.claudeWeekObservedAt, 205,
               "Claude-stämpeln ska följa PC:ns pool");
  assert.equal(merged.codexWeekPct, 41, "Codex ska komma från Macen");
  assert.equal(merged.codexWeekObservedAt, 190,
               "stämpeln ska följa sin pools vinnare");
});

test("en pool bara den ena maskinen känner överlever", () => {
  const utan = { receivedAt: 300, publisher: "pc",
                 body: { v: 2, weekPct: 73, weekObservedAt: 295 } };
  const med = { receivedAt: 250, publisher: "mac",
                body: { v: 2, weekPct: 60, weekObservedAt: 200,
                        codexWeekPct: 41, codexWeekObservedAt: 240 } };
  const merged = mergeTokens([utan, med]);
  assert.equal(merged.codexWeekPct, 41,
               "att PC:n aldrig sett Codex får inte radera Codex-siffran");
  assert.equal(merged.weekPct, 73);
});

test("ostämplade fält följer det nyast mottagna dokumentet", () => {
  const gammal = { receivedAt: 100, publisher: "mac",
                   body: { v: 2, daySessions: 4 } };
  const ny = { receivedAt: 200, publisher: "pc",
               body: { v: 2, daySessions: 9 } };
  assert.equal(mergeTokens([gammal, ny]).daySessions, 9);
});

test("döda och korrupta dokument tystar inte de andra", () => {
  const frisk = { receivedAt: 100, publisher: "mac",
                  body: { v: 2, weekPct: 73 } };
  assert.equal(mergeTokens([null, { receivedAt: 1, body: null },
                            frisk]).weekPct, 73);
  assert.equal(mergeTokens([]), null);
  assert.equal(mergeTokens([null]), null);
});

test("newestBody är nyast mottagna, inget annat", () => {
  const a = { receivedAt: 100, publisher: "mac", body: { streak: 3 } };
  const b = { receivedAt: 200, publisher: "pc", body: { streak: 1 } };
  assert.equal(newestBody([a, b]).streak, 1);
  assert.equal(newestBody([]), null);
});

test("en vinnande pool tar med sig hela gruppen, inte bara sina egna fält", () => {
  // PC:n har sett Claude senast men skickar inget claudeWeekStale; Macens
  // äldre stale-flagga och ResetMin får inte sitta kvar under PC:ns Pct.
  const mac = { receivedAt: 210, publisher: "mac", body: {
    v: 2, claudeWeekPct: 70, claudeWeekStale: true, claudeWeekResetMin: 900,
    claudeWeekObservedAt: 150,
  } };
  const pc = { receivedAt: 200, publisher: "pc", body: {
    v: 2, claudeWeekPct: 73, claudeWeekObservedAt: 205,
  } };
  const merged = mergeTokens([mac, pc]);
  assert.equal(merged.claudeWeekPct, 73);
  assert.equal(merged.claudeWeekObservedAt, 205);
  assert.equal("claudeWeekStale" in merged, false,
               "förlorarens Stale-flagga får inte överleva under vinnarens Pct");
  assert.equal("claudeWeekResetMin" in merged, false,
               "förlorarens ResetMin får inte överleva under vinnarens Pct");
  assert.equal(merged.v, 2, "ostämplade fält följer fortfarande basen");
});

test("en pool utan stämpel hos någon lämnas orörd från basen", () => {
  const mac = { receivedAt: 210, publisher: "mac",
                body: { v: 2, daySessions: 4, claudeWeekPct: 70 } };
  const pc = { receivedAt: 200, publisher: "pc",
               body: { v: 2, daySessions: 9, claudeWeekPct: 73 } };
  assert.equal(mergeTokens([mac, pc]).claudeWeekPct, 70);
});

// --- Sökvägshemligheten jämförs i konstant tid ---------------------------

const SECRET = "s".repeat(64);

test("rätt hemlighet och tillåten endpoint löses upp", async () => {
  const endpoints = ["/api/tokens", "/api/max-tracker", "/api/github"];
  assert.equal(await resolveEndpoint(
      `https://relay.test/u/${SECRET}/api/tokens`, SECRET, endpoints),
    "/api/tokens");
  assert.equal(await resolveEndpoint(
      `https://relay.test/u/${SECRET}/api/github`, SECRET, endpoints),
    "/api/github");
});

test("fel, för kort, förlängd eller saknad hemlighet ger null", async () => {
  const endpoints = ["/api/tokens"];
  for (const candidate of [
    "x".repeat(64), SECRET.slice(0, 63), SECRET + "s", SECRET.toUpperCase(),
    "", "u",
  ])
    assert.equal(await resolveEndpoint(
        `https://relay.test/u/${candidate}/api/tokens`, SECRET, endpoints),
      null, JSON.stringify(candidate));
  assert.equal(await resolveEndpoint(
      `https://relay.test/${SECRET}/api/tokens`, SECRET, endpoints), null);
  assert.equal(await resolveEndpoint(
      `https://relay.test/u/${SECRET}`, SECRET, endpoints), null);
  assert.equal(await resolveEndpoint(
      `https://relay.test/u/${SECRET}/`, SECRET, endpoints), null);
  assert.equal(await resolveEndpoint(
      `https://relay.test/u/${SECRET}/api/agent-status`, SECRET, endpoints),
    null);
  assert.equal(await resolveEndpoint(
      `https://relay.test/u/${SECRET}/api/tokens/extra`, SECRET, endpoints),
    null);
});

// --- Dokumentformen: siffror, korta strängar, grunt nästlade ------------

test("de tre riktiga värsta-fall-dokumenten accepteras", () => {
  for (const doc of [realTokensDocument(), realMaxTrackerDocument(),
                     realGithubDocument(), { v: 1, enabled: false }]) {
    assert.equal(bodyShapeProblem(doc), null);
    assert.ok(utf8ByteLength(JSON.stringify(doc)) < MAX_BODY_BYTES);
  }
});

test("prosa, djupa nästen, långa listor och icke-objekt avvisas", () => {
  assert.equal(typeof bodyShapeProblem({ note: "x".repeat(MAX_STRING_CHARS + 1) }),
               "string");
  assert.equal(bodyShapeProblem({ note: "x".repeat(MAX_STRING_CHARS) }), null);
  assert.equal(typeof bodyShapeProblem({ a: { b: { c: { d: { e: 1 } } } } }),
               "string", "fem behållare djupt är för djupt");
  assert.equal(bodyShapeProblem({ a: { b: { c: { d: 1 } } } }), null,
               "fyra behållare djupt räcker för Max Tracker");
  assert.equal(typeof bodyShapeProblem({ list: Array(513).fill(0) }), "string");
  assert.equal(typeof bodyShapeProblem({ "bad key!": 1 }), "string");
  assert.equal(typeof bodyShapeProblem({ ["k".repeat(65)]: 1 }), "string");
  assert.equal(typeof bodyShapeProblem(
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, i]))),
    "string");
  for (const notObject of [[], 1, "x", null, true])
    assert.equal(typeof bodyShapeProblem(notObject), "string");
  const wide = { rows: Array.from({ length: 512 }, () => Array(9).fill(0)) };
  assert.equal(typeof bodyShapeProblem(wide), "string",
               "för många noder totalt avvisas även när varje del är liten");
});

test("kroppens storlek mäts i UTF-8-byte, inte UTF-16-enheter", () => {
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("å"), 2);
  assert.equal(utf8ByteLength("\u{1F600}"), 4);
});
