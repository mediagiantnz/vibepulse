#ifndef AGENT_MONITOR_POLICY_H
#define AGENT_MONITOR_POLICY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "agent_status.h"

/*
 * THE freshness rule for an agent job's state. Every reader (the quota
 * pages' live header and halo, keep-awake, the simulator) goes through
 * tk_agent_monitor_effective_state, so there is exactly one answer to "is
 * this state still true?":
 *
 *  - WORKING is a heartbeat claim. It expires when the job's own event age
 *    (updated_ms, as the service reported it) plus the age of the packet
 *    that carried it passes TK_AGENT_WORKING_LEASE_MS.
 *  - WAITING and ERROR are parked states. A question can legitimately sit
 *    unanswered for an hour, so their own event age does not count, but the
 *    PACKET carrying them must be within the same lease: a feed that died
 *    two minutes ago cannot keep a question "live" on the glass
 *    (docs/lessons.md, 2026-08-13: stale data replayed as breaking news).
 *  - DONE, IDLE and UNKNOWN pass through unchanged; DONE alerts have their
 *    own freshness gate in agent_completion_policy.
 *
 * An expired state becomes UNKNOWN: never DONE, never a guess.
 */
#define TK_AGENT_WORKING_LEASE_MS 120000ULL

tk_agent_state tk_agent_monitor_effective_state(
    const tk_agent_status *status, uint64_t packet_age_ms);
bool tk_agent_monitor_status_present(const tk_agent_status *status,
                                     const char *dismissed_event_id,
                                     uint64_t packet_age_ms);
bool tk_agent_monitor_should_keep_awake(const tk_agent_status *status,
                                        const char *dismissed_event_id,
                                        uint64_t packet_age_ms);

/* Display-safe project alphabet: ASCII A-Z, 0-9, space, '-', '.', '_',
 * plus Swedish ÅÄÖ. ASCII and Swedish lowercase are uppercased; every other
 * valid UTF-8 code point becomes '?'. Output is always NUL-terminated when
 * capacity is nonzero and never ends with a partial UTF-8 sequence. */
void tk_agent_monitor_project_label(const char *source, char *destination,
                                    size_t capacity);

#endif
