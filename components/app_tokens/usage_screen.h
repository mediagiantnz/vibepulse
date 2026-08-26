#ifndef USAGE_SCREEN_H
#define USAGE_SCREEN_H

#include <stdbool.h>
#include <stdint.h>

#include "lvgl.h"

#include "app_tokens_config.h"
#include "agent_status.h"
#include "github_status.h"
#include "max_tracker.h"
#include "tokens.h"

/* Seven fixed tiles (six quota/analytics pages + the Value page) followed by
 * the optional GitHub tile, which is always the LAST index (see the VIEW_*
 * enum in app_tokens.h). */
#define TK_USAGE_SCREEN_VIEWS (7 + TK_GITHUB_SCREEN_ENABLED)

/* Per-feed staleness (OBS-09). Each feed goes stale on its OWN clock, at a
 * threshold above its own poll cadence, so a dead /api/max-tracker or
 * /api/github can never hide under a healthy /api/tokens. The quota feed
 * (30 s cadence) and GitHub (30 s) share the 120 s threshold app.c has
 * always used; Max Tracker polls every 5 min, so two missed polls plus
 * margin is its honest threshold. */
#define TK_FEED_STALE_AFTER_US (120LL * 1000000LL)
#define TK_TRACKER_STALE_AFTER_US (11LL * 60LL * 1000000LL)

void usage_screen_create(lv_obj_t *root);
void usage_screen_apply_tokens(const tk_tokens *tokens);
void usage_screen_apply_agent(const tk_agent_snapshot *snapshot,
                              int64_t now_us);
void usage_screen_apply_agent_status_relay(
    const tk_agent_snapshot *snapshot, int64_t now_us);
void usage_screen_apply_max_tracker(const tk_max_tracker *t);
void usage_screen_apply_github(const tk_github_status *status);
void usage_screen_tick(int64_t now_us);
void usage_screen_set_stale(bool stale);
void usage_screen_show_view(int index);
int usage_screen_current_view(void);

#endif
