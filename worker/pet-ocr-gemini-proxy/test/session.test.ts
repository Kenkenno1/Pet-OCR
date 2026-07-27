import { SELF, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const allowedOrigin = "http://localhost:3000";

function sessionRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      Origin: allowedOrigin,
      "content-type": "application/json",
      "CF-Connecting-IP": "203.0.113.9"
    },
    body: JSON.stringify(body)
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("Turnstile-backed session", () => {
  it("verifies a one-time challenge and returns a signed persisted session", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      );
      const fields = new URLSearchParams(String(init?.body));
      expect(fields.get("secret")).toBe("test-turnstile-secret");
      expect(fields.get("response")).toBe("one-time-turnstile-token");
      expect(fields.get("remoteip")).toBe("203.0.113.9");
      return Response.json({
        success: true,
        hostname: "localhost",
        action: "pet-ocr-session"
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await SELF.fetch(
      "https://worker.test/v1/session",
      sessionRequest({ turnstileToken: "one-time-turnstile-token" })
    );
    const body = await response.json<{
      token: string;
      expiresAt: number;
      idleExpiresAt: number;
      limits: { sessionCalls: number };
    }>();

    expect(response.status).toBe(201);
    expect(body.token.split(".")).toHaveLength(2);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.idleExpiresAt).toBeGreaterThan(Date.now());
    expect(body.limits.sessionCalls).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid Turnstile result without creating a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          success: false,
          "error-codes": ["invalid-input-response"]
        })
      )
    );

    const response = await SELF.fetch(
      "https://worker.test/v1/session",
      sessionRequest({ turnstileToken: "bad-token" })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "turnstile_failed" }
    });
  });

  it("rejects extra schema fields before calling Siteverify", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await SELF.fetch(
      "https://worker.test/v1/session",
      sessionRequest({ turnstileToken: "token", apiKey: "must-not-be-accepted" })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request" }
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("streams and rejects an oversized session body before Siteverify", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await SELF.fetch("https://worker.test/v1/session", {
      method: "POST",
      headers: {
        Origin: allowedOrigin,
        "content-type": "application/json",
        "CF-Connecting-IP": "203.0.113.9"
      },
      body: JSON.stringify({ turnstileToken: "x".repeat(20_000) })
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "request_too_large" }
    });
    expect(upstream).not.toHaveBeenCalled();
  });
});
