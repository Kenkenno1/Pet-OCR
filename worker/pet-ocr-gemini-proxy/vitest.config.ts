import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        bindings: {
          GEMINI_API_KEY: "test-gemini-key",
          TURNSTILE_SECRET_KEY: "test-turnstile-secret",
          SESSION_HMAC_SECRET: "test-session-hmac-secret-with-32-bytes"
        }
      },
      wrangler: {
        configPath: "./wrangler.jsonc"
      }
    })
  ]
});
