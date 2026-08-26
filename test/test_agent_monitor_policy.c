#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../components/app_tokens/agent_monitor_policy.h"

static int failures;

static void check(const char *what, int condition) {
  if (!condition) {
    printf("FAIL %s\n", what);
    failures++;
  }
}

static tk_agent_status agent(tk_agent_state state, uint32_t updated_ms,
                             const char *event_id) {
  tk_agent_status value = {0};
  value.state = state;
  value.updated_ms = updated_ms;
  snprintf(value.event_id, sizeof value.event_id, "%s", event_id);
  return value;
}

int main(void) {
  char project[TK_AGENT_PROJECT_CAP];
  tk_agent_monitor_project_label("my-app 2", project, sizeof project);
  check("ascii project alphabet uppercases deterministically",
        strcmp(project, "MY-APP 2") == 0);
  tk_agent_monitor_project_label("R\xC3\xA4ksm\xC3\xB6rg\xC3\xA5s",
                                 project, sizeof project);
  check("svenska projektbokstäver uppercases as UTF-8",
        strcmp(project, "R\xC3\x84KSM\xC3\x96RG\xC3\x85S") == 0);
  tk_agent_monitor_project_label("M\xC3\xBCnchen!", project,
                                 sizeof project);
  check("unsupported UTF-8 and punctuation use display-safe replacement",
        strcmp(project, "M?NCHEN?") == 0);
  char bounded[4] = {0};
  tk_agent_monitor_project_label("\xC3\xA5\xC3\xA5", bounded,
                                 sizeof bounded);
  check("bounded project output never splits a UTF-8 glyph",
        strcmp(bounded, "\xC3\x85") == 0);

  /* --- WORKING is a heartbeat: event age + packet age within the lease --- */
  tk_agent_status fresh_work = agent(TK_AGENT_WORKING, 100, "work-fresh");
  check("färskt arbete är närvarande",
        tk_agent_monitor_status_present(&fresh_work, "", 0));
  check("färskt närvarande arbete håller skärmen vaken",
        tk_agent_monitor_should_keep_awake(&fresh_work, "", 0));

  tk_agent_status stale_event =
      agent(TK_AGENT_WORKING, 120001, "work-stale-event");
  check("gammal eventtid gör working unknown",
        tk_agent_monitor_effective_state(&stale_event, 0) ==
            TK_AGENT_UNKNOWN);
  check("gammal raw working är inte närvarande",
        !tk_agent_monitor_status_present(&stale_event, "", 0));
  check("gammal raw working håller inte skärmen vaken",
        !tk_agent_monitor_should_keep_awake(&stale_event, "", 0));

  tk_agent_status stale_packet =
      agent(TK_AGENT_WORKING, 0, "work-stale-packet");
  check("gammalt paket gör working unknown, aldrig done",
        tk_agent_monitor_effective_state(&stale_packet, 120001) ==
            TK_AGENT_UNKNOWN);
  check("gammalt paket döljer working",
        !tk_agent_monitor_status_present(&stale_packet, "", 120001));
  check("gammalt paket håller inte skärmen vaken",
        !tk_agent_monitor_should_keep_awake(&stale_packet, "", 120001));

  tk_agent_status combined_stale =
      agent(TK_AGENT_WORKING, 80000, "work-combined-stale");
  check("eventtid plus paketålder följer 120-sekundersleasen",
        tk_agent_monitor_effective_state(&combined_stale, 40001) ==
            TK_AGENT_UNKNOWN);

  tk_agent_status boundary =
      agent(TK_AGENT_WORKING, 80000, "work-boundary");
  check("exakt 120 sekunder är fortfarande giltigt",
        tk_agent_monitor_effective_state(&boundary, 40000) ==
            TK_AGENT_WORKING);

  tk_agent_status dismissed =
      agent(TK_AGENT_WORKING, 0, "work-dismissed");
  check("kvitterat working är inte närvarande",
        !tk_agent_monitor_status_present(&dismissed, "work-dismissed", 0));
  check("kvitterat working håller inte skärmen vaken",
        !tk_agent_monitor_should_keep_awake(&dismissed, "work-dismissed", 0));

  /* --- WAITING/ERROR are parked: their own age is free, the packet's is
   * not. One rule, shared with the quota header (usage_live_policy). --- */
  tk_agent_status parked = agent(TK_AGENT_WAITING, 3600000, "wait-old");
  check("en timme gammal fråga är fortfarande waiting i ett färskt paket",
        tk_agent_monitor_effective_state(&parked, 0) == TK_AGENT_WAITING);
  check("waiting gäller exakt vid paketleasens gräns",
        tk_agent_monitor_effective_state(&parked, TK_AGENT_WORKING_LEASE_MS) ==
            TK_AGENT_WAITING);
  check("waiting i ett dött flöde blir unknown, inte kvar som live",
        tk_agent_monitor_effective_state(&parked,
                                         TK_AGENT_WORKING_LEASE_MS + 1) ==
            TK_AGENT_UNKNOWN);
  check("utgången waiting är inte närvarande",
        !tk_agent_monitor_status_present(&parked, "",
                                         TK_AGENT_WORKING_LEASE_MS + 1));
  tk_agent_status errored = agent(TK_AGENT_ERROR, 0, "error-1");
  check("error följer samma paketlease",
        tk_agent_monitor_effective_state(&errored, 0) == TK_AGENT_ERROR &&
        tk_agent_monitor_effective_state(&errored,
                                         TK_AGENT_WORKING_LEASE_MS + 1) ==
            TK_AGENT_UNKNOWN);
  check("waiting håller aldrig skärmen vaken",
        !tk_agent_monitor_should_keep_awake(&parked, "", 0));

  /* --- DONE/IDLE pass through: completion alerts have their own gate --- */
  tk_agent_status done = agent(TK_AGENT_DONE, 0, "done-terminal");
  check("terminal status är närvarande",
        tk_agent_monitor_status_present(&done, "", 0));
  check("done påverkas inte av paketåldern",
        tk_agent_monitor_effective_state(&done, TK_AGENT_WORKING_LEASE_MS + 1)
            == TK_AGENT_DONE);
  check("terminal status håller inte skärmen vaken",
        !tk_agent_monitor_should_keep_awake(&done, "", 0));
  tk_agent_status idle = agent(TK_AGENT_IDLE, 0, "");
  check("idle är aldrig närvarande",
        !tk_agent_monitor_status_present(&idle, "", 0));
  check("null-status är unknown, aldrig en krasch",
        tk_agent_monitor_effective_state(NULL, 0) == TK_AGENT_UNKNOWN);

  if (failures == 0) {
    printf("OK: alla agentmonitor-policytester gröna\n");
    return 0;
  }
  printf("%d test föll\n", failures);
  return 1;
}
