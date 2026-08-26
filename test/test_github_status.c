#include <stdio.h>
#include <string.h>

#include "../components/app_tokens/github_status_parse.h"

static int failures;

static void check(const char *what, int condition) {
  if (!condition) {
    printf("FAIL %s\n", what);
    failures++;
  }
}

static void rejected_unchanged(const char *what, const char *json) {
  tk_github_status value;
  memset(&value, 0xa5, sizeof value);
  tk_github_status before = value;
  if (tk_github_status_parse(json, strlen(json), &value)) {
    printf("FAIL %s accepted\n", what);
    failures++;
  }
  check("rejection keeps output unchanged",
        memcmp(&value, &before, sizeof value) == 0);
}

#define VALID \
  "{\"v\":1,\"enabled\":true,\"repo\":\"niclasvestlund-YT/vibepulse\"," \
  "\"project\":\"vibepulse\",\"stars\":42,\"forks\":3,\"stale\":false}"

int main(void) {
  tk_github_status value = {0};
  check("valid baseline parses",
        tk_github_status_parse(VALID, strlen(VALID), &value));
  check("baseline values",
        value.enabled && value.has_data && !value.stale &&
        value.stars == 42 && value.forks == 3 &&
        strcmp(value.repo, "niclasvestlund-YT/vibepulse") == 0 &&
        strcmp(value.project, "vibepulse") == 0 &&
        !value.has_event);

  const char event[] =
      "{\"v\":1,\"enabled\":true,\"repo\":\"niclasvestlund-YT/vibepulse\","
      "\"project\":\"vibepulse\",\"stars\":43,\"forks\":3,\"stale\":false,"
      "\"eventId\":\"2026-08-14T18:02:00Z\",\"actor\":\"octocat\","
      "\"eventStars\":43}";
  check("star event parses",
        tk_github_status_parse(event, strlen(event), &value));
  check("event identity",
        value.has_event && value.has_actor && value.event_stars == 43 &&
        strcmp(value.actor, "octocat") == 0);

  const char actor_missing[] =
      "{\"v\":1,\"enabled\":true,\"repo\":\"a/b\",\"project\":\"b\","
      "\"stars\":8,\"forks\":0,\"stale\":false,"
      "\"eventId\":\"count:8\",\"actor\":null,\"eventStars\":8}";
  check("count-only event parses",
        tk_github_status_parse(actor_missing, strlen(actor_missing), &value));
  check("missing actor is explicit", value.has_event && !value.has_actor);

  const char collecting[] =
      "{\"v\":1,\"enabled\":true,\"repo\":\"a/b\",\"project\":\"b\","
      "\"stale\":true}";
  check("pre-baseline state parses",
        tk_github_status_parse(collecting, strlen(collecting), &value));
  check("pre-baseline has no invented zero",
        value.enabled && !value.has_data && value.stale);

  const char disabled[] = "{\"v\":1,\"enabled\":false}";
  check("disabled state parses",
        tk_github_status_parse(disabled, strlen(disabled), &value));
  check("disabled is explicit", !value.enabled && !value.has_data);

  rejected_unchanged("wrong version",
                     "{\"v\":2,\"enabled\":false}");
  rejected_unchanged("extra field when disabled",
                     "{\"v\":1,\"enabled\":false,\"stars\":1}");
  rejected_unchanged("private-looking URL",
                     "{\"v\":1,\"enabled\":true,\"repo\":\"https://x/y\","
                     "\"project\":\"y\",\"stars\":1,\"forks\":0,"
                     "\"stale\":false}");
  rejected_unchanged("fractional stars",
                     "{\"v\":1,\"enabled\":true,\"repo\":\"a/b\","
                     "\"project\":\"b\",\"stars\":1.5,\"forks\":0,"
                     "\"stale\":false}");
  rejected_unchanged("only one metric",
                     "{\"v\":1,\"enabled\":true,\"repo\":\"a/b\","
                     "\"project\":\"b\",\"stars\":1,\"stale\":false}");
  rejected_unchanged("event without actor key",
                     "{\"v\":1,\"enabled\":true,\"repo\":\"a/b\","
                     "\"project\":\"b\",\"stars\":2,\"forks\":0,"
                     "\"stale\":false,\"eventId\":\"count:2\","
                     "\"eventStars\":2}");
  rejected_unchanged("event count disagrees",
                     "{\"v\":1,\"enabled\":true,\"repo\":\"a/b\","
                     "\"project\":\"b\",\"stars\":2,\"forks\":0,"
                     "\"stale\":false,\"eventId\":\"count:1\","
                     "\"actor\":\"octocat\",\"eventStars\":1}");
  rejected_unchanged("duplicate field",
                     "{\"v\":1,\"v\":1,\"enabled\":false}");
  rejected_unchanged("embedded NUL",
                     "{\"v\":1,\"enabled\":true,\"repo\":\"a/b\","
                     "\"project\":\"bi\\u0000p\",\"stale\":true}");
  rejected_unchanged("trailing JSON",
                     "{\"v\":1,\"enabled\":false}[]");
  rejected_unchanged("unknown field",
                     "{\"v\":1,\"enabled\":false,\"future\":1}");
  /* Hostile depth: CJSON_NESTING_LIMIT is 16 in every build, so a 20-deep
   * value fails inside cJSON itself, on a bounded stack, before any field
   * rule runs. */
  rejected_unchanged("20-deep nesting",
                     "{\"v\":1,\"enabled\":true,\"repo\":"
                     "[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]],"
                     "\"project\":\"b\",\"stars\":1,\"forks\":0,"
                     "\"stale\":false}");

  if (failures) {
    printf("%d GitHub parser tests failed\n", failures);
    return 1;
  }
  printf("GitHub parser tests passed\n");
  return 0;
}
