/*
 * Request-side guards shared by worker.js and bootstrap.js, kept free of the
 * Cloudflare runtime so node --test can hold them still:
 *
 *   resolveEndpoint  - the secret in /u/<secret>/api/... is compared in
 *                      constant time (SHA-256 both sides, then a fixed-width
 *                      compare) instead of a prefix test that returns early
 *                      on the first wrong byte.
 *   bodyShapeProblem - a numbers document is numbers, booleans, null, short
 *                      strings and a few shallow containers. Anything else
 *                      (prose, deep nests, long lists) is refused before it
 *                      is stored, so the mailbox cannot become a note pad.
 *   noStoreHeaders   - every response is Cache-Control: no-store; the URL is
 *                      the credential and intermediaries must never keep a
 *                      body keyed on it.
 */

export const MAX_BODY_BYTES = 64 * 1024; // largest honest payload is ~8 kB
// GitHub's longest full repository name is 39 + 1 + 100 characters; every
// other honest string (labels, ISO timestamps, versions) is far shorter.
export const MAX_STRING_CHARS = 160;
export const MAX_KEY_CHARS = 64;
// Max Tracker is the deepest honest document: root > provider > days > pair.
export const MAX_CONTAINER_DEPTH = 4;
export const MAX_OBJECT_KEYS = 128;
// Max Tracker's days list is 20 weeks x 7 days = 140 entries.
export const MAX_ARRAY_LENGTH = 512;
export const MAX_NODES = 4096;

const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function utf8ByteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(text),
  );
  return new Uint8Array(digest);
}

function fixedWidthEqual(a, b) {
  // Both inputs are 32-byte digests, so the loop length never depends on
  // the candidate. Workers offer a native primitive; use it when present.
  if (typeof crypto.subtle.timingSafeEqual === "function")
    return crypto.subtle.timingSafeEqual(a, b);
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1)
    difference |= a[index] ^ (b[index] ?? 0);
  return difference === 0;
}

export async function secretMatches(candidate, secret) {
  if (typeof candidate !== "string" || typeof secret !== "string")
    return false;
  const [candidateHash, secretHash] = await Promise.all([
    sha256(candidate), sha256(secret),
  ]);
  return fixedWidthEqual(candidateHash, secretHash);
}

export async function resolveEndpoint(url, secret, endpoints) {
  const path = new URL(url).pathname;
  if (!path.startsWith("/u/")) return null;
  const rest = path.slice(3);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const candidate = rest.slice(0, slash);
  const endpoint = rest.slice(slash);
  const allowed = endpoints.includes(endpoint);
  const matched = await secretMatches(candidate, secret);
  return allowed && matched ? endpoint : null;
}

function scalarProblem(value, where) {
  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? null : `${where}: non-finite number`;
    case "boolean":
      return null;
    case "string":
      return value.length <= MAX_STRING_CHARS
        ? null : `${where}: string longer than ${MAX_STRING_CHARS}`;
    default:
      return value === null ? null : `${where}: unsupported value`;
  }
}

/*
 * Return null when `value` is an acceptable numbers document, otherwise a
 * short reason. The reason never echoes document content, only positions.
 */
export function bodyShapeProblem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "root: not an object";
  let nodes = 0;
  const walk = (node, depth, where) => {
    nodes += 1;
    if (nodes > MAX_NODES) return `${where}: more than ${MAX_NODES} nodes`;
    if (node === null || typeof node !== "object")
      return scalarProblem(node, where);
    if (depth > MAX_CONTAINER_DEPTH)
      return `${where}: nested deeper than ${MAX_CONTAINER_DEPTH}`;
    if (Array.isArray(node)) {
      if (node.length > MAX_ARRAY_LENGTH)
        return `${where}: list longer than ${MAX_ARRAY_LENGTH}`;
      for (let index = 0; index < node.length; index += 1) {
        const problem = walk(node[index], depth + 1, `${where}[${index}]`);
        if (problem !== null) return problem;
      }
      return null;
    }
    const keys = Object.keys(node);
    if (keys.length > MAX_OBJECT_KEYS)
      return `${where}: more than ${MAX_OBJECT_KEYS} keys`;
    for (const key of keys) {
      if (!KEY_PATTERN.test(key)) return `${where}: unacceptable key`;
      const problem = walk(node[key], depth + 1, `${where}.${key}`);
      if (problem !== null) return problem;
    }
    return null;
  };
  return walk(value, 1, "root");
}

export function noStoreHeaders(extra = {}) {
  return { "Cache-Control": "no-store", ...extra };
}

export function textResponse(body, status = 200) {
  return new Response(body, { status, headers: noStoreHeaders() });
}

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: noStoreHeaders({ "Content-Type": "application/json" }),
  });
}

/*
 * Read a POST body under the byte limit and parse it as a numbers document.
 * Returns { document, raw } or { response } with the exact status the wire
 * contract promises: 413 over the limit, 400 for bad UTF-8, bad JSON, or a
 * shape no honest publisher sends.
 */
export async function readNumbersBody(request) {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES)
    return { response: textResponse("too large", 413) };
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { response: textResponse("not json", 400) };
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    return { response: textResponse("not json", 400) };
  }
  if (bodyShapeProblem(document) !== null)
    return { response: textResponse("bad shape", 400) };
  return { document, raw };
}
