/*
 * Pure merge rules for the numbers mailbox. Kept outside the Cloudflare
 * entrypoint so node --test can hold the wire semantics still without a
 * Workers runtime.
 */

function poolKey(key, group, stamp) {
  return key === stamp ||
    (key.startsWith(group) && !key.endsWith("ObservedAt"));
}

export function mergeTokens(docs) {
  const alive = docs.filter((d) => d && typeof d.body === "object" &&
                                   d.body !== null);
  if (alive.length === 0) return null;
  alive.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
  const merged = { ...alive[0].body };

  const groups = new Set();
  for (const doc of alive)
    for (const key of Object.keys(doc.body))
      if (key.endsWith("ObservedAt")) groups.add(key.slice(0, -10));

  for (const group of groups) {
    const stamp = group + "ObservedAt";
    let winner = null;
    for (const doc of alive) {
      const at = doc.body[stamp];
      if (typeof at !== "number") continue;
      if (winner === null || at > winner.body[stamp]) winner = doc;
    }
    if (winner === null) continue;
    // The whole pool follows its winner: a loser's Stale flag or ResetMin
    // must not sit under the winner's Pct just because the winner did not
    // send that field. Clear every pool key any document carries first.
    for (const doc of alive)
      for (const key of Object.keys(doc.body))
        if (poolKey(key, group, stamp)) delete merged[key];
    for (const key of Object.keys(winner.body))
      if (poolKey(key, group, stamp)) merged[key] = winner.body[key];
  }
  return merged;
}

export function newestBody(docs) {
  const alive = docs.filter((d) => d && typeof d.body === "object" &&
                                   d.body !== null);
  if (alive.length === 0) return null;
  alive.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
  return alive[0].body;
}
