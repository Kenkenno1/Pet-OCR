import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const allowedOrigin = "http://localhost:3000";

describe("strict route and origin boundary", () => {
  it("answers an allowed preflight with the exact origin", async () => {
    const response = await SELF.fetch("https://worker.test/v1/session", {
      method: "OPTIONS",
      headers: {
        Origin: allowedOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("rejects a disallowed origin without reflecting it", async () => {
    const response = await SELF.fetch("https://worker.test/v1/session", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "content-type": "application/json"
      },
      body: JSON.stringify({ turnstileToken: "token" })
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toMatchObject({
      error: { code: "origin_forbidden" }
    });
  });

  it("rejects unsupported methods before reading a request body", async () => {
    const response = await SELF.fetch("https://worker.test/v1/session", {
      method: "GET",
      headers: { Origin: allowedOrigin }
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  });
});
