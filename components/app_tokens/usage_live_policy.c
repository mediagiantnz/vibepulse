#include "usage_live_policy.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "agent_monitor_policy.h"

/* Freshness has already been applied by tk_agent_monitor_effective_state:
 * an expired WORKING, WAITING or ERROR arrives here as UNKNOWN. */
static bool is_active(tk_agent_state state) {
  return state == TK_AGENT_WORKING || state == TK_AGENT_WAITING ||
         state == TK_AGENT_ERROR;
}

static void build_now_context(const tk_agent_status *working,
                              usage_live_header_view *out) {
  const bool has_model = working->has_model && working->model[0];
  const bool has_effort = working->has_effort && working->effort[0];
  if (has_model && has_effort) {
    snprintf(out->context, sizeof out->context, "NOW · %s · %s",
             working->model, working->effort);
  } else if (has_model) {
    snprintf(out->context, sizeof out->context, "NOW · %s", working->model);
  } else if (has_effort) {
    snprintf(out->context, sizeof out->context, "NOW · %s", working->effort);
  } else {
    snprintf(out->context, sizeof out->context, "NOW");
  }
}

void usage_live_build_header(const tk_agent_provider_status *provider,
                             uint64_t packet_age_ms, bool data_stale,
                             bool has_agent_data,
                             usage_live_header_view *out) {
  if (!out) return;
  memset(out, 0, sizeof *out);
  if (!has_agent_data || !provider || data_stale) return;

  const uint8_t job_count = provider->job_count < TK_AGENT_JOBS_MAX
                                ? provider->job_count
                                : TK_AGENT_JOBS_MAX;
  unsigned active_count = 0;
  const tk_agent_status *working = NULL;
  for (uint8_t i = 0; i < job_count; i++) {
    tk_agent_state state =
        tk_agent_monitor_effective_state(&provider->jobs[i], packet_age_ms);
    if (!is_active(state)) continue;
    active_count++;
    if (state == TK_AGENT_WORKING) working = &provider->jobs[i];
  }

  out->halo_active = working != NULL;
  if (active_count == 0) {
    snprintf(out->context, sizeof out->context, "NO ACTIVE AGENT");
  } else if (active_count == 1 && working) {
    build_now_context(working, out);
  } else if (active_count == 1) {
    snprintf(out->context, sizeof out->context, "1 AGENT ACTIVE");
  } else {
    snprintf(out->context, sizeof out->context, "%u AGENTS ACTIVE",
             active_count);
  }
}

bool usage_live_build_today_bar(double total_pct, bool has_total,
                                double today_pct, bool has_today,
                                int track_width, usage_today_bar_view *out) {
  if (!out) return false;
  memset(out, 0, sizeof *out);
  if (!has_total || !isfinite(total_pct) || total_pct < 0.0 ||
      total_pct > 100.0 || track_width <= 0) {
    return false;
  }

  out->has_total = true;
  out->total_px = (int)llround(total_pct * (double)track_width / 100.0);
  out->baseline_px = out->total_px;
  if (!has_today) return true;
  if (!isfinite(today_pct) || today_pct < 0.0 || today_pct > total_pct) {
    memset(out, 0, sizeof *out);
    return false;
  }

  out->has_today = true;
  out->baseline_px =
      (int)llround((total_pct - today_pct) * (double)track_width / 100.0);
  out->today_px = out->total_px - out->baseline_px;
  out->marker_x = out->baseline_px;
  return true;
}
