#ifndef AGENT_STATUS_H
#define AGENT_STATUS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TK_AGENT_ID_CAP 65
#define TK_AGENT_PROJECT_CAP 17
#define TK_AGENT_MODEL_CAP 25
#define TK_AGENT_EFFORT_CAP 13
#define TK_AGENT_PROVIDER_COUNT 2
#define TK_AGENT_JOBS_MAX 4

typedef enum {
  TK_AGENT_PROVIDER_CLAUDE = 0,
  TK_AGENT_PROVIDER_CODEX = 1,
} tk_agent_provider;

typedef enum {
  TK_AGENT_IDLE,
  TK_AGENT_WORKING,
  TK_AGENT_WAITING,
  TK_AGENT_DONE,
  TK_AGENT_ERROR,
  TK_AGENT_UNKNOWN,
} tk_agent_state;

typedef enum {
  TK_ACTIVITY_NONE,
  TK_ACTIVITY_THINKING,
  TK_ACTIVITY_READING,
  TK_ACTIVITY_EDITING,
  TK_ACTIVITY_SEARCHING,
  TK_ACTIVITY_RUNNING,
  TK_ACTIVITY_TESTING,
  TK_ACTIVITY_BUILDING,
  TK_ACTIVITY_WAITING_INPUT,
  TK_ACTIVITY_WAITING_APPROVAL,
  TK_ACTIVITY_UNKNOWN,
} tk_agent_activity;

typedef struct {
  char task_id[TK_AGENT_ID_CAP];
  char event_id[TK_AGENT_ID_CAP];
  char project[TK_AGENT_PROJECT_CAP];
  char model[TK_AGENT_MODEL_CAP];
  char effort[TK_AGENT_EFFORT_CAP];
  bool has_model;
  bool has_effort;
  tk_agent_state state;
  tk_agent_activity activity;
  uint32_t updated_ms;
} tk_agent_status;

typedef struct {
  uint8_t active_count;
  uint8_t job_count;
  tk_agent_status jobs[TK_AGENT_JOBS_MAX];
} tk_agent_provider_status;

/* "Needs You": one interaction a Claude Code session is blocked on, parked by
 * the bridge and waiting for a tap. Optional on the wire — an older service
 * simply never sends it, and a malformed one is ignored rather than allowed to
 * take the agent list down with it (see tk_agent_status_parse). */
#define TK_PENDING_ID_CAP 33     /* <=32 legacy hex/base64url + NUL */
#define TK_PENDING_VIEW_SHA256_CAP 65 /* 64 lowercase hex + NUL */
#define TK_PENDING_PROMPT_CAP 97 /* server bound 96 + NUL */
#define TK_PENDING_TITLE_CAP 65  /* server bound 64 + NUL */
#define TK_PENDING_TOOL_CAP 25

typedef enum {
  TK_PENDING_QUESTION,
  TK_PENDING_APPROVAL,
} tk_pending_kind;

/* Pending decisions arrive independently from the direct LAN status feed and
 * the optional encrypted relay. NONE is the parser/default value until the
 * owning monitor assigns the slot. */
typedef enum {
  TK_PENDING_SOURCE_NONE = 0,
  TK_PENDING_SOURCE_LAN,
  TK_PENDING_SOURCE_RELAY,
} tk_pending_source;

typedef struct {
  bool present;
  tk_pending_source source;
  /* Missing on legacy Claude payloads. Codex is never accepted without an
   * explicit provider and view digest, so it can never fall back to v1. */
  tk_agent_provider provider;
  bool has_view_sha256;
  tk_pending_kind kind;
  /* can_approve is the server's verdict, never the panel's guess: it is false
   * for anything truncated, anything outside the approvable tier, and for
   * every payload when detail is not shared. The panel must not offer APPROVE
   * without it. */
  bool can_approve;
  bool marked; /* Claude explicitly flagged the option as recommended */
  bool has_prompt;
  bool has_title;
  bool has_subtitle;
  bool has_tool;
  bool has_project;
  /* Authenticated relay binding retained when the LAN and relay slots mirror
   * the same exact public view. It is binary to avoid a second decode in the
   * UI path. Never sufficient on its own: source selection and digest equality
   * are enforced by interaction_relay_policy. */
  bool has_relay_binding;
  uint8_t options_total;
  uint32_t expires_in_ms;
  /* The interaction's original hold duration. The countdown ring is
   * expires_in_ms against this, so it maps to the real terminal-fallback
   * time. 0 when an older service does not send it (ring reads as full). */
  uint32_t hold_ms;
  char request_id[TK_PENDING_ID_CAP];
  char view_sha256[TK_PENDING_VIEW_SHA256_CAP];
  char project[TK_AGENT_PROJECT_CAP];
  char prompt[TK_PENDING_PROMPT_CAP];
  char title[TK_PENDING_TITLE_CAP];
  char subtitle[TK_PENDING_TITLE_CAP];
  char tool[TK_PENDING_TOOL_CAP];
  uint8_t relay_challenge[32];
  uint8_t relay_view_sha256[32];
} tk_pending_interaction;

typedef struct {
  uint32_t seq;
  tk_agent_provider_status claude;
  tk_agent_provider_status codex;
  tk_pending_interaction pending;
} tk_agent_snapshot;

#endif
