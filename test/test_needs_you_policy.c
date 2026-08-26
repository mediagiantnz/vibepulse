/* What the panel is allowed to show and send when Claude needs the human. */
#include <stdio.h>
#include <string.h>

#include "../components/app_tokens/needs_you_policy.h"

static int failures;

static void check(const char *what, int condition) {
  if (!condition) {
    printf("FAIL %s\n", what);
    failures++;
  }
}

static tk_pending_interaction question(void) {
  tk_pending_interaction pending = {0};
  pending.present = true;
  pending.kind = TK_PENDING_QUESTION;
  pending.can_approve = true;
  pending.marked = true;
  pending.has_title = true;
  pending.options_total = 2;
  pending.expires_in_ms = 118000;
  memcpy(pending.request_id, "6750af25a1f5ab4161fc7698c3f84d60", 33);
  memcpy(pending.title, "New auth layer", 15);
  return pending;
}

int main(void) {
  tk_needs_you_state state;
  tk_needs_you_reset(&state);

  /* Nothing waiting: the panel keeps doing its day job. */
  tk_pending_interaction empty = {0};
  tk_needs_you_view view = tk_needs_you_view_of(&state, &empty);
  check("utan pending tar inget över skärmen", !view.visible);

  /* A live question takes the glass and offers everything. */
  tk_pending_interaction pending = question();
  view = tk_needs_you_view_of(&state, &pending);
  check("en fråga tar över skärmen", view.visible);
  check("frågan erbjuder både godkänn och neka",
        view.offer_approve && view.offer_deny);
  check("sorten följer med till vyn", view.kind == TK_PENDING_QUESTION);

  /* No answer channel (no device key, sender never started): the screen
   * may only hand the question back to the terminal. */
  tk_needs_you_view no_channel = view;
  tk_needs_you_restrict_offers(&no_channel, false);
  check("utan svarskanal finns bara LÄMNA DET",
        no_channel.visible && !no_channel.offer_approve &&
        !no_channel.offer_deny);
  check("utan svarskanal får varken godkänn eller neka skickas",
        !tk_needs_you_allows(&pending, &no_channel,
                             TK_NEEDS_YOU_VERDICT_APPROVE) &&
        !tk_needs_you_allows(&pending, &no_channel,
                             TK_NEEDS_YOU_VERDICT_DENY) &&
        tk_needs_you_allows(&pending, &no_channel,
                            TK_NEEDS_YOU_VERDICT_LEAVE_IT));
  tk_needs_you_view with_channel = view;
  tk_needs_you_restrict_offers(&with_channel, true);
  check("med svarskanal ändras inget",
        with_channel.offer_approve && with_channel.offer_deny);
  tk_needs_you_restrict_offers(NULL, false);

  /* "ON IT" is only honest for an answer that actually left the device:
   * the takeover leaves and the payoff plays on the channel's word, never
   * on the tap alone. LEAVE IT is local and always dismisses. */
  tk_needs_you_outcome outcome =
      tk_needs_you_outcome_of(TK_NEEDS_YOU_VERDICT_APPROVE, true);
  check("köat godkännande försvinner och spelar ON IT",
        outcome.dismiss && outcome.payoff && !outcome.unsent);
  outcome = tk_needs_you_outcome_of(TK_NEEDS_YOU_VERDICT_APPROVE, false);
  check("oköat godkännande stannar kvar och säger NOT SENT",
        !outcome.dismiss && !outcome.payoff && outcome.unsent);
  outcome = tk_needs_you_outcome_of(TK_NEEDS_YOU_VERDICT_DENY, true);
  check("köat nekande försvinner utan ON IT",
        outcome.dismiss && !outcome.payoff && !outcome.unsent);
  outcome = tk_needs_you_outcome_of(TK_NEEDS_YOU_VERDICT_DENY, false);
  check("oköat nekande stannar kvar",
        !outcome.dismiss && !outcome.payoff && outcome.unsent);
  outcome = tk_needs_you_outcome_of(TK_NEEDS_YOU_VERDICT_LEAVE_IT, false);
  check("lämna det är lokalt och försvinner även utan kanal",
        outcome.dismiss && !outcome.payoff && !outcome.unsent);

  /* The countdown ring is expires against the original hold, in per-mille,
   * computed by the policy so the widget never has to guess a duration. */
  pending = question();
  pending.expires_in_ms = 60000;
  pending.hold_ms = 120000;
  view = tk_needs_you_view_of(&state, &pending);
  check("ringen är halv vid halva hålltiden", view.ring_permille == 500);
  pending.expires_in_ms = 130000;  /* a stale clock never overfills the ring */
  view = tk_needs_you_view_of(&state, &pending);
  check("ringen klampas till full, aldrig över", view.ring_permille == 1000);
  pending.hold_ms = 0;             /* older service: no known duration */
  pending.expires_in_ms = 42000;
  view = tk_needs_you_view_of(&state, &pending);
  check("utan känd hålltid läser ringen full", view.ring_permille == 1000);
  pending = question();

  /* can_approve is the service's call; the panel never overrides it upward. */
  pending.can_approve = false;
  view = tk_needs_you_view_of(&state, &pending);
  check("utan tjänstens ja finns ingen godkänn-knapp",
        view.visible && !view.offer_approve);
  check("neka går alltid, även då", view.offer_deny);
  check("en godkännande som aldrig erbjöds får inte skickas",
        !tk_needs_you_allows(&pending, &view,
                             TK_NEEDS_YOU_VERDICT_APPROVE));
  check("neka är tillåtet", tk_needs_you_allows(
      &pending, &view, TK_NEEDS_YOU_VERDICT_DENY));
  check("lämna till terminalen är alltid tillåtet", tk_needs_you_allows(
      &pending, &view, TK_NEEDS_YOU_VERDICT_LEAVE_IT));

  pending = question();
  view = tk_needs_you_view_of(&state, &pending);
  check("med tjänstens ja får godkännandet skickas",
        tk_needs_you_allows(&pending, &view, TK_NEEDS_YOU_VERDICT_APPROVE));

  /* Answering hides it immediately rather than after the next poll. */
  tk_needs_you_mark_answered(&state, &pending);
  view = tk_needs_you_view_of(&state, &pending);
  check("besvarad interaktion försvinner direkt vid trycket",
        !view.visible);
  check("och går inte att svara på igen",
        !tk_needs_you_allows(&pending, &view,
                             TK_NEEDS_YOU_VERDICT_APPROVE) &&
        !tk_needs_you_allows(&pending, &view, TK_NEEDS_YOU_VERDICT_DENY));

  /* ...but the next interaction is a different one and must get through. */
  tk_pending_interaction next = question();
  memcpy(next.request_id, "0000000000000000000000000000abcd", 33);
  view = tk_needs_you_view_of(&state, &next);
  check("nästa interaktion tar över som vanligt", view.visible);

  /* Nearly expired: raising the screen would be theatre.
   * NB: a fresh request_id. Reusing the answered one made these three
   * assertions pass for the wrong reason — suppressed as answered rather
   * than as expiring. */
  tk_pending_interaction expiring = question();
  memcpy(expiring.request_id, "2222222222222222222222222222f00d", 33);
  expiring.expires_in_ms = TK_NEEDS_YOU_MIN_SHOW_MS - 1;
  view = tk_needs_you_view_of(&state, &expiring);
  check("nästan utgången interaktion tar inte över skärmen",
        !view.visible);
  expiring.expires_in_ms = 0;
  view = tk_needs_you_view_of(&state, &expiring);
  check("utgången interaktion tar inte över skärmen", !view.visible);
  expiring.expires_in_ms = TK_NEEDS_YOU_MIN_SHOW_MS;
  check("precis över gränsen syns den",
        tk_needs_you_view_of(&state, &expiring).visible);

  /* An approval with a command the panel may not show: walk to the desk. */
  tk_pending_interaction approval = {0};
  approval.present = true;
  approval.kind = TK_PENDING_APPROVAL;
  approval.expires_in_ms = 60000;
  memcpy(approval.request_id, "1111111111111111111111111111beef", 33);
  view = tk_needs_you_view_of(&state, &approval);
  check("en oläsbar approval syns men går bara att neka",
        view.visible && !view.offer_approve && view.offer_deny);

  /* Nothing may be sent for an interaction that is not on screen. */
  tk_needs_you_view hidden = {0};
  check("inget får skickas för en osynlig interaktion",
        !tk_needs_you_allows(&pending, &hidden,
                             TK_NEEDS_YOU_VERDICT_APPROVE) &&
        !tk_needs_you_allows(&pending, &hidden, TK_NEEDS_YOU_VERDICT_DENY) &&
        !tk_needs_you_allows(&pending, &hidden,
                             TK_NEEDS_YOU_VERDICT_LEAVE_IT));

  /* Defensive: null arguments never crash and never authorize anything. */
  tk_needs_you_reset(NULL);
  tk_needs_you_mark_answered(NULL, &pending);
  tk_needs_you_mark_answered(&state, NULL);
  check("nullargument nekar i stället för att krascha",
        !tk_needs_you_view_of(NULL, &pending).visible &&
        !tk_needs_you_view_of(&state, NULL).visible &&
        !tk_needs_you_allows(NULL, &view, TK_NEEDS_YOU_VERDICT_DENY) &&
        !tk_needs_you_allows(&pending, NULL, TK_NEEDS_YOU_VERDICT_DENY));

  if (failures == 0) {
    printf("OK: alla needs-you-policytester gröna\n");
    return 0;
  }
  printf("%d test föll\n", failures);
  return 1;
}
