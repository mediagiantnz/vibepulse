import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const TEST_MAC_TOKEN = "ERERERERERERERERERERERERERERERERERERERERERE";
const TEST_PANEL_TOKEN = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI";

// Wrangler validates required-secret presence before Miniflare applies its
// in-memory test bindings. These are public fixture values, never credentials.
process.env.MAC_TOKEN ??= TEST_MAC_TOKEN;
process.env.PANEL_TOKEN ??= TEST_PANEL_TOKEN;

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          MAC_TOKEN: TEST_MAC_TOKEN,
          PANEL_TOKEN: TEST_PANEL_TOKEN,
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    // deploy.test.mjs is a node:test suite for the deploy guard; it runs
    // under plain Node from `npm test`, not inside the Workers pool.
    include: ["test/**/*.test.ts"],
  },
});
