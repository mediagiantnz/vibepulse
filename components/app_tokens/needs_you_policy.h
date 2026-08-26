#ifndef NEEDS_YOU_POLICY_H
#define NEEDS_YOU_POLICY_H

#include <stdbool.h>
#include <stdint.h>

#include "agent_status.h"

/* What the panel does when a Claude Code session is blocked on the human.
 *
 * Kept out of the LVGL layer on purpose: every rule below is a decision with
 * a consequence for someone's repository, and decisions belong somewhere they
 * can be tested on a host without a display.
 */

typedef enum {
  TK_NEEDS_YOU_VERDICT_APPROVE,
  TK_NEEDS_YOU_VERDICT_DENY,
  TK_NEEDS_YOU_VERDICT_LEAVE_IT,
} tk_needs_you_verdict;

/* Below this the takeover is not worth raising: it would flash up and be
 * gone before anyone could read it, and a decision half-read is worse than
 * one taken at the desk. */
#define TK_NEEDS_YOU_MIN_SHOW_MS 3000u

typedef struct {
  bool visible;
  bool offer_approve;   /* only ever true when the service allowed it AND
                         * the panel has a channel to send it on */
  bool offer_deny;      /* denying reveals nothing, so it is offered
                         * whenever visible and the panel can send it */
  /* The countdown ring, as a fraction of the interaction's original hold in
   * per-mille (1000 = full, 0 = about to fall back to the terminal). Computed
   * here, not in the widget, so the ring always maps to the real fallback
   * time. When the service sends no original duration the ring reads full. */
  uint16_t ring_permille;
  tk_pending_kind kind;
} tk_needs_you_view;

typedef struct {
  char answered_id[TK_PENDING_ID_CAP];
  bool has_answered;
} tk_needs_you_state;

void tk_needs_you_reset(tk_needs_you_state *state);

/* The whole render decision, from the latest poll. Pure: same inputs, same
 * answer, no clock of its own. */
tk_needs_you_view tk_needs_you_view_of(const tk_needs_you_state *state,
                                       const tk_pending_interaction *pending);

/* A panel with no answer channel (no device key compiled in, or the sender
 * never started) can only ever LEAVE IT: offering APPROVE or DENY would be
 * buttons that tell no one. Apply after tk_needs_you_view_of. */
void tk_needs_you_restrict_offers(tk_needs_you_view *view, bool has_channel);

/* What the glass may do once a verdict has been handed to the answer
 * channel. queued is the channel's own word: true only when the signed
 * answer is actually on its way. Honesty rule: the takeover disappears and
 * the ON IT beat plays ONLY for an answer that left the device; an answer
 * the channel refused keeps the takeover on the glass and says so. LEAVE IT
 * is always a local decision (the terminal already holds the interaction),
 * so it dismisses whether or not anything was sent. */
typedef struct {
  bool dismiss; /* mark answered: the takeover leaves at the tap */
  bool payoff;  /* play the ON IT beat (an APPROVE that really left) */
  bool unsent;  /* keep the takeover and show NOT SENT */
} tk_needs_you_outcome;

tk_needs_you_outcome tk_needs_you_outcome_of(tk_needs_you_verdict verdict,
                                             bool queued);

/* May this verdict be sent for this interaction at all?
 *
 * The service checks this too. The panel checks it as well because an APPROVE
 * it never offered must never leave the device — a stray touch event, a
 * mis-wired callback or a stale frame should fail here, not at the far end.
 */
bool tk_needs_you_allows(const tk_pending_interaction *pending,
                         const tk_needs_you_view *view,
                         tk_needs_you_verdict verdict);

/* Remember that this interaction was answered, so the takeover disappears at
 * the tap instead of lingering for up to a poll while the service catches up.
 */
void tk_needs_you_mark_answered(tk_needs_you_state *state,
                                const tk_pending_interaction *pending);

#endif
