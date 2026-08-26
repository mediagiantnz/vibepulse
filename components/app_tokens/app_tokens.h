#ifndef APP_TOKENS_H
#define APP_TOKENS_H

#include <stdbool.h>
#include <stdint.h>

#include "torget_app.h"

#include "tokens.h"
#include "agent_status.h"
#include "github_status.h"
#include "max_tracker.h"

/*
 * VibePulse: Claude/Codex-usage och agentstatus på hyllan.
 * Datat kommer från den lilla Mac-tjänsten i tools/tokenserver/ (platt JSON
 * enligt glance-mönstret, över LAN). Appen har en egen lokal 100 ms-tickare
 * mellan hämtningarna (tick_cb i app.c, se usage_screen_tick) — INTE
 * Solelkollens delade tickerkomponent (ticker.h/sg_ticker); den användningen
 * satt bara i den borttagna volymvyn och försvann härifrån med den.
 */

extern const torget_app_t tokens_app;

/* Tile order. The seven fixed tiles come first so every index below
 * TK_USAGE_SCREEN_VIEWS is a real tile in every build; the optional GitHub
 * tile is LAST and only exists when TK_GITHUB_SCREEN_ENABLED is 1. Putting
 * an optional tile in the middle once left VIEW_VALUE pointing one past a
 * seven-element tile array in the default build (empty black column before
 * the Value page, pager never highlighting it). usage_screen.c static-asserts
 * this ordering against TK_USAGE_SCREEN_VIEWS. */
enum {
  VIEW_CLAUDE_FABLE = 0,
  VIEW_CLAUDE_ALL = 1,
  VIEW_CODEX_WEEKLY = 2,
  VIEW_BURN_RATE = 3,
  VIEW_TRACKER_CLAUDE = 4,
  VIEW_TRACKER_CODEX = 5,
  VIEW_VALUE = 6,
  VIEW_GITHUB = 7, /* optional, only created with TK_GITHUB_SCREEN_ENABLED */
};

/* Ett lyckat /api/tokens-svar. Snappar tickern, stämplar färskhet och
 * håller skärmen vaken när tokens brinner. Kallas under torget_ui_lock(). */
void tokens_apply(const tk_tokens *t);

/* Ett lyckat /api/agent-status-svar, redan parsat och under UI-låset. */
void tokens_apply_agent_status(const tk_agent_snapshot *snapshot);

/* Authenticated, E2E relay rows. These return whether relay source policy
 * allowed an apply/one-shot clear. Callers hold torget_ui_lock(). */
bool tokens_apply_agent_status_relay(const tk_agent_snapshot *snapshot,
                                     int64_t now_us);
bool tokens_clear_agent_status_relay(int64_t now_us);

/* Ett lyckat /api/max-tracker-svar, redan parsat och under UI-låset. */
void tokens_apply_max_tracker(const tk_max_tracker *t);

/* One strict /api/github payload. The optional page and popup have separate
 * compile-time switches; either can consume the same feed. */
void tokens_apply_github(const tk_github_status *status);

/* Targetets 1 Hz-hämtning. Utan TK_AGENT_STATUS_URL loggas avstängt läge
 * och ingen task eller HTTP-klient skapas. */
void tokens_agent_net_start(void);
void tokens_github_net_start(void);

/* Hoppa till en VibePulse-vy utan animation — bänkens och BMP-dumparnas
 * ratt. */
void tokens_show_view(int idx);

#endif
