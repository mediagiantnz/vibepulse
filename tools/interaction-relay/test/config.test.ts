import { describe, expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";


describe("interaction relay Worker configuration", () => {
  it("pins one typed SQLite Durable Object without secrets", () => {
    const config = JSON.parse(raw) as Record<string, unknown>;

    expect(config.name).toBe("vibepulse-interaction-relay");
    expect(config.main).toBe("src/index.ts");
    expect(config.compatibility_date).toBe("2026-08-20");
    expect(config.compatibility_flags).toContain("nodejs_compat");
    // Invocation logs retain the Authorization header (both bearer tokens)
    // for seven days; only the Worker's own redacted console.log lines may
    // reach Workers Logs.
    expect(config.observability).toEqual({
      enabled: true,
      logs: { invocation_logs: false },
    });
    expect(config.durable_objects).toEqual({
      bindings: [{
        name: "INTERACTION_MAILBOX",
        class_name: "InteractionMailbox",
      }],
    });
    expect(config.exports).toEqual({
      InteractionMailbox: { type: "durable-object", storage: "sqlite" },
    });
    expect(config.secrets).toEqual({
      required: ["MAC_TOKEN", "PANEL_TOKEN"],
    });
    expect(config.vars).toEqual({
      MAILBOX_ID: "vp_A1b2C3d4E5f6G7h8",
    });
    expect(config).not.toHaveProperty("migrations");
    expect(config).not.toHaveProperty("kv_namespaces");
    expect(config.vars).not.toHaveProperty("MAC_TOKEN");
    expect(config.vars).not.toHaveProperty("PANEL_TOKEN");
  });
});
