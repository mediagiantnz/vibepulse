/*
 * Rollback-compatible first stage for introducing NumbersMailbox.
 *
 * This entrypoint deliberately keeps the original KV request path while it
 * exports the new Durable Object class. Deploy it first to apply the class
 * lifecycle change without changing public behavior; later deployments can
 * switch main to worker.js and can roll back only as far as this bootstrap.
 */

import { mergeTokens, newestBody } from "./merge.js";
import {
  jsonResponse, readNumbersBody, resolveEndpoint, textResponse,
} from "./guard.js";

export { NumbersMailbox } from "./worker.js";

const ENDPOINTS = ["/api/tokens", "/api/max-tracker", "/api/github"];
const MAX_PUBLISHERS = 8;

async function readDocs(env, endpoint) {
  const listed = await env.VIBEPULSE.list({ prefix: `${endpoint}:` });
  const docs = [];
  for (const key of listed.keys.slice(0, MAX_PUBLISHERS)) {
    const raw = await env.VIBEPULSE.get(key.name);
    if (!raw) continue;
    try {
      docs.push(JSON.parse(raw));
    } catch {
      /* ett korrupt dokument tystar inte de andra */
    }
  }
  return docs;
}

export default {
  async fetch(request, env) {
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
      const doc = JSON.stringify({
        receivedAt: Date.now() / 1000,
        publisher,
        body: read.document,
      });
      await env.VIBEPULSE.put(`${endpoint}:${publisher}`, doc);
      return textResponse("ok", 200);
    }

    if (request.method === "GET") {
      const docs = await readDocs(env, endpoint);
      const merged = endpoint === "/api/tokens" ? mergeTokens(docs)
                                                : newestBody(docs);
      if (merged === null) return jsonResponse({ error: "no data yet" }, 404);
      return jsonResponse(merged);
    }

    return textResponse("method not allowed", 405);
  },
};
