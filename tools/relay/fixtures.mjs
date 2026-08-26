/*
 * The three real worst-case numbers documents, key for key what
 * tools/tokenserver publisher.py sends (get_snapshot + value_meter,
 * max_tracker.build_payload, github_monitor.snapshot). Shared by test.mjs and
 * mailbox.vitest.mjs so the Worker's shape guard is held to the real payloads,
 * not to a guess.
 */

export function realTokensDocument() {
  // Samma nycklar som tools/tokenserver get_snapshot + value_meter skickar.
  return {
    v: 2, at: "2026-08-26T21:14:05+12:00",
    dayTokens: 1234567, dayTokensPerHour: 45678, daySessions: 9,
    monthTokens: 98765432,
    value: {
      value_usd: 812.44, plan_usd: 200, cost_source: "configured",
      basis: "list API prices", prices_as_of: "2026-08-01",
      unpriced_token_share: 0.0123, undeclared_usd: 12.5,
      claude_usd: 700.1, claude_plan_usd: 200, codex_usd: 112.34,
      codex_plan_usd: 20, state: "ok", multiple: 4.06,
    },
    claudeSessionPct: 12, claudeSessionResetMin: 231,
    claudeWeekPct: 73, claudeWeekResetMin: 4321,
    claudeWeekObservedAt: 1787000000.5, claudeWeekStale: false,
    claudeModelWeekPct: 40, claudeModelWeekResetMin: 4321,
    claudeModelWeekObservedAt: 1787000000.5,
    claudeModelWeekLabel: "OPUS · WEEK", claudeModelWeekStale: false,
    codexSessionPct: null, codexSessionResetMin: null,
    codexWeekPct: 41, codexWeekResetMin: 3000,
    codexWeekObservedAt: 1786990000, codexWeekStale: true,
    claudeWeekTodayDeltaPct: 3, claudeModelWeekTodayDeltaPct: 2,
    claudeSessionHourDeltaPct: 1, codexWeekTodayDeltaPct: null,
    claudeForecastState: "ok", claudeForecastPctAtReset: 88,
    claudeForecastPaceFactor: 1.3, claudeForecastAt: 1787400000,
    claudeForecastOffsetMin: -120,
    codexForecastState: "unavailable", codexForecastPctAtReset: null,
    codexForecastPaceFactor: null, codexForecastAt: null,
    codexForecastOffsetMin: null,
    otaAvailableVersion: "0.7.0",
  };
}

export function realMaxTrackerDocument() {
  // 20 veckor x 7 dagar per leverantör, varje dag ett [pct, lvl/vol]-par.
  const provider = () => ({
    planLabel: "MAX 20X", avgPeakPct: 77.5, maxWeeksStreak: 999,
    maxWeeks: 999, maxDays: 999,
    weekMaxed: Array.from({ length: 20 }, (_, i) => i % 2),
    days: Array.from({ length: 140 }, (_, i) => [i % 101, 1234567 + i]),
  });
  return { v: 1, weeks: 20, stale: false, codingStreakDays: 999,
           claude: provider(), codex: provider() };
}

export function realGithubDocument() {
  return {
    v: 1, enabled: true,
    repo: `${"o".repeat(39)}/${"r".repeat(100)}`, project: "r".repeat(100),
    stale: false, stars: 1234, forks: 56,
    eventId: "2026-08-26T09:14:05Z", actor: "a".repeat(39), eventStars: 1234,
  };
}
