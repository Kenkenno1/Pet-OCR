import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("public HTTP contract", () => {
  it("returns an exact health response without exposing secrets", async () => {
    const response = await SELF.fetch("https://worker.test/healthz", {
      headers: {
        Origin: "http://localhost:3000"
      }
    });

    const responseText = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(responseText)).toEqual({
      ok: true,
      service: "pet-ocr-gemini-proxy"
    });
    expect(responseText).not.toContain("test-gemini-key");
    expect(responseText).not.toContain("test-turnstile-secret");
    expect(responseText).not.toContain("test-session-hmac-secret");
  });
});
