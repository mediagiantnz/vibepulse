#ifndef AGENT_MONITOR_H
#define AGENT_MONITOR_H

#include <stdbool.h>
#include <stdint.h>

#include "lvgl.h"

#include "agent_status.h"
#include "interaction_relay_policy.h"
#include "needs_you_policy.h"

void tk_agent_monitor_create(lv_obj_t *app_root);
void tk_agent_monitor_apply(const tk_agent_snapshot *snapshot, int64_t now_us);
/* Replace only seq/Claude/Codex from authenticated status relay data. The
 * independently selected LAN/relay pending interaction remains untouched. */
void tk_agent_monitor_apply_status_relay(
    const tk_agent_snapshot *snapshot, int64_t now_us);
/* Apply only the encrypted relay slot. Agent rows and the independent LAN
 * pending slot remain untouched. Passing NULL/an absent item clears the relay
 * slot. The caller holds torget_ui_lock; this function performs no I/O. */
void tk_agent_monitor_apply_relay(const tk_pending_interaction *pending,
                                  int64_t now_us);
void tk_agent_monitor_tick(int64_t now_us);

/* Content-free render diagnostics. Safe to log: counters contain no prompt,
 * command, project, provider, or request identifier. */
typedef struct {
  uint32_t full_repaints;
  uint32_t ring_updates;
  uint32_t unchanged_ticks;
} tk_agent_render_stats;
void tk_agent_monitor_render_stats(tk_agent_render_stats *out);
void tk_agent_monitor_render_stats_reset(void);

/* Deterministisk simulatorväg; glastrycket går genom samma köfunktion. */
void tk_agent_monitor_dismiss_current(void);

/* A "Needs You" verdict left the glass: the human tapped APPROVE / DENY /
 * LEAVE IT on the interactive takeover. The app layer wires this to the signed
 * network queue. context is a copied provider/source/relay binding for the
 * exact visible item. The callback must only queue; no crypto, HTTP, or other
 * blocking work is allowed on the LVGL task. Never called for a verdict the
 * policy would not allow.
 *
 * CONTRACT: return true only when the verdict was actually queued for
 * delivery. The monitor marks the interaction answered and plays the ON IT
 * beat on that word alone; false (queue full, binding refused) keeps the
 * takeover up and shows NOT SENT, so the glass never claims an answer that
 * stayed on the device. With no callback registered at all (no device key)
 * the screens offer LEAVE IT only. The simulator's callback prints the
 * canonical message and returns true. */
typedef bool (*tk_agent_monitor_needs_you_cb)(
    tk_needs_you_verdict verdict, const tk_ir_decision_context *context);
void tk_agent_monitor_set_needs_you_cb(tk_agent_monitor_needs_you_cb cb);

/* Deterministic simulator/test paths for the two-stage summon. A tap opens the
 * decision from attract (and, on the private screen, hands off to the terminal);
 * a press resolves a decision button. On the device these run from LVGL touch. */
void tk_agent_monitor_needs_you_tap(void);
void tk_agent_monitor_needs_you_press(tk_needs_you_verdict verdict);

#endif
