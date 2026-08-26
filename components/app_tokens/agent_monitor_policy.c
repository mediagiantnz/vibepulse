#include "agent_monitor_policy.h"

#include <string.h>

static bool utf8_continuation(unsigned char byte) {
  return (byte & 0xC0U) == 0x80U;
}

static size_t utf8_sequence_length(const unsigned char *source) {
  unsigned char lead = source[0];
  if (lead < 0x80U) return 1;
  if (lead >= 0xC2U && lead <= 0xDFU && source[1] &&
      utf8_continuation(source[1])) {
    return 2;
  }
  if (lead >= 0xE0U && lead <= 0xEFU && source[1] && source[2] &&
      utf8_continuation(source[1]) && utf8_continuation(source[2])) {
    return 3;
  }
  if (lead >= 0xF0U && lead <= 0xF4U && source[1] && source[2] &&
      source[3] && utf8_continuation(source[1]) &&
      utf8_continuation(source[2]) && utf8_continuation(source[3])) {
    return 4;
  }
  return 1;
}

static bool project_ascii(unsigned char byte) {
  return (byte >= 'A' && byte <= 'Z') ||
         (byte >= '0' && byte <= '9') || byte == ' ' || byte == '-' ||
         byte == '.' || byte == '_';
}

void tk_agent_monitor_project_label(const char *source, char *destination,
                                    size_t capacity) {
  if (!destination || capacity == 0) return;
  destination[0] = '\0';
  if (!source) return;

  const unsigned char *cursor = (const unsigned char *)source;
  size_t output = 0;
  while (*cursor) {
    unsigned char encoded[2] = {'?', 0};
    size_t encoded_length = 1;
    size_t consumed = utf8_sequence_length(cursor);

    if (cursor[0] < 0x80U) {
      unsigned char byte = cursor[0];
      if (byte >= 'a' && byte <= 'z') byte = (unsigned char)(byte - 32U);
      encoded[0] = project_ascii(byte) ? byte : '?';
    } else if (consumed == 2 && cursor[0] == 0xC3U &&
               (cursor[1] == 0x84U || cursor[1] == 0x85U ||
                cursor[1] == 0x96U || cursor[1] == 0xA4U ||
                cursor[1] == 0xA5U || cursor[1] == 0xB6U)) {
      encoded[0] = 0xC3U;
      encoded[1] = cursor[1] == 0xA4U ? 0x84U :
                   cursor[1] == 0xA5U ? 0x85U :
                   cursor[1] == 0xB6U ? 0x96U : cursor[1];
      encoded_length = 2;
    }

    if (output + encoded_length >= capacity) break;
    memcpy(destination + output, encoded, encoded_length);
    output += encoded_length;
    cursor += consumed;
  }
  destination[output] = '\0';
}

/* See the header for the rule; this is its only implementation. */
tk_agent_state tk_agent_monitor_effective_state(
    const tk_agent_status *status, uint64_t packet_age_ms) {
  if (!status) return TK_AGENT_UNKNOWN;
  switch (status->state) {
    case TK_AGENT_WORKING:
      if ((uint64_t)status->updated_ms > TK_AGENT_WORKING_LEASE_MS ||
          packet_age_ms >
              TK_AGENT_WORKING_LEASE_MS - (uint64_t)status->updated_ms) {
        return TK_AGENT_UNKNOWN;
      }
      return TK_AGENT_WORKING;
    case TK_AGENT_WAITING:
    case TK_AGENT_ERROR:
      return packet_age_ms > TK_AGENT_WORKING_LEASE_MS ? TK_AGENT_UNKNOWN
                                                       : status->state;
    default:
      return status->state;
  }
}

bool tk_agent_monitor_status_present(const tk_agent_status *status,
                                     const char *dismissed_event_id,
                                     uint64_t packet_age_ms) {
  tk_agent_state state =
      tk_agent_monitor_effective_state(status, packet_age_ms);
  if (state == TK_AGENT_IDLE || state == TK_AGENT_UNKNOWN) return false;
  return !dismissed_event_id || !status->event_id[0] ||
         strcmp(status->event_id, dismissed_event_id) != 0;
}

bool tk_agent_monitor_should_keep_awake(const tk_agent_status *status,
                                        const char *dismissed_event_id,
                                        uint64_t packet_age_ms) {
  return tk_agent_monitor_effective_state(status, packet_age_ms) ==
             TK_AGENT_WORKING &&
         tk_agent_monitor_status_present(status, dismissed_event_id,
                                         packet_age_ms);
}
