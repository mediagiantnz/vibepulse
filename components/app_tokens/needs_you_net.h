#ifndef NEEDS_YOU_NET_H
#define NEEDS_YOU_NET_H

#include <stdbool.h>
#include <stdint.h>

#include "interaction_relay_policy.h"
#include "needs_you_policy.h"

/*
 * Wall-clock sync gate, shared by every sender that stamps or evaluates a
 * wall-clock time. The board has no battery-backed RTC: until SNTP has
 * answered, time(NULL) counts up from the 1970 epoch, so it is never <= 0
 * and "time is zero" can never detect an unsynced clock (2026-08-26). The
 * platform's NET_READY waits at most 20 s for SNTP and then proceeds, so
 * a task that has passed torget_net_wait() still cannot assume a clock.
 * 1 700 000 000 (2023-11-14) is below any moment this firmware can
 * legitimately run in and above anything an unsynced clock can reach.
 * Pure and header-only so the host tests can pin the boundary. */
#define TK_WALL_CLOCK_SYNC_FLOOR_S 1700000000LL

static inline bool tk_wall_clock_synced(int64_t wall_seconds) {
  return wall_seconds >= TK_WALL_CLOCK_SYNC_FLOOR_S;
}

/* The device's answer channel. Registers the takeover's verdict callback and
 * sends signed POSTs to the bridge on a worker task, so a tap never blocks the
 * UI on the network. Compiled to no-ops without TK_VIBEPULSE_DEVICE_KEY, which
 * leaves the screens display-only (LEAVE IT and the private tap still dismiss
 * locally, they just tell no one). */
void tokens_needs_you_net_start(void);

/* KEY3 panic: deny everything parked, from the platform's button handler. */
void tk_needs_you_send_panic(void);

/* Optional strong implementation supplied by the encrypted relay client in
 * Task 9. The default weak implementation fails closed. Called only from the
 * Needs You network worker, never from LVGL; implementations must copy the
 * immutable decision binding into their own bounded queue. */
bool tk_interaction_relay_queue_verdict(
    tk_needs_you_verdict verdict, const tk_ir_decision_context *context);

#endif
