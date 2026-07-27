import { SELF, env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const allowedOrigin = "http://localhost:3000";
const clientIp = "203.0.113.20";

async function issueSession(): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        success: true,
        hostname: "localhost",
        action: "pet-ocr-session"
      })
    )
  );
  const response = await SELF.fetch("https://worker.test/v1/session", {
    method: "POST",
    headers: {
      Origin: allowedOrigin,
      "content-type": "application/json",
      "CF-Connecting-IP": clientIp
    },
    body: JSON.stringify({ turnstileToken: "challenge" })
  });
  const body = await response.json<{ token: string }>();
  return body.token;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("session authentication is the authorization boundary", () => {
  it("rejects a non-browser client that forges an allowed Origin but has no session", async () => {
    const response = await SELF.fetch("https://worker.test/v1/translate", {
      method: "POST",
      headers: {
        Origin: allowedOrigin,
        "content-type": "application/json",
        "CF-Connecting-IP": clientIp
      },
      body: JSON.stringify({ html: "<p>Hello</p>" })
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "session_required" }
    });
  });

  it("rejects a tampered HMAC session token", async () => {
    const token = await issueSession();
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    const response = await SELF.fetch("https://worker.test/v1/translate", {
      method: "POST",
      headers: {
        Origin: allowedOrigin,
        Authorization: `Bearer ${tampered}`,
        "content-type": "application/json",
        "CF-Connecting-IP": clientIp
      },
      body: JSON.stringify({ html: "<p>Hello</p>" })
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "session_invalid" }
    });
  });

  it("invalidates old tokens after an HMAC secret rotation", async () => {
    const token = await issueSession();
    const rotatedEnv = {
      ...(env as unknown as Env),
      SESSION_HMAC_SECRET: "rotated-test-session-secret-with-32-bytes"
    };

    const response = await worker.fetch(
      new Request("https://worker.test/v1/translate", {
        method: "POST",
        headers: {
          Origin: allowedOrigin,
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "CF-Connecting-IP": clientIp
        },
        body: JSON.stringify({ html: "<p>Hello</p>" })
      }),
      rotatedEnv
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "session_invalid" }
    });
  });

  it("expires an idle session after 24 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 6, 27, 0, 0, 0));
    const token = await issueSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "<p>你好</p>" }] } }
          ],
          usageMetadata: {}
        })
      )
    );
    vi.setSystemTime(Date.UTC(2026, 6, 28, 0, 0, 1));

    const response = await SELF.fetch("https://worker.test/v1/translate", {
      method: "POST",
      headers: {
        Origin: allowedOrigin,
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "CF-Connecting-IP": clientIp
      },
      body: JSON.stringify({ html: "<p>Hello</p>" })
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "session_expired" }
    });
  });

  it("enforces the seven-day absolute lifetime even when idle time keeps refreshing", async () => {
    vi.useFakeTimers();
    const issuedAt = Date.UTC(2026, 6, 27, 0, 0, 0);
    vi.setSystemTime(issuedAt);
    const token = await issueSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "<p>你好</p>" }] } }
          ],
          usageMetadata: {}
        })
      )
    );

    for (let hours = 23; hours < 7 * 24; hours += 23) {
      vi.setSystemTime(issuedAt + hours * 60 * 60 * 1000);
      const keepAlive = await SELF.fetch("https://worker.test/v1/translate", {
        method: "POST",
        headers: {
          Origin: allowedOrigin,
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "CF-Connecting-IP": `203.0.113.${20 + hours}`
        },
        body: JSON.stringify({ html: "<p>Hello</p>" })
      });
      expect(keepAlive.status).toBe(200);
    }

    vi.setSystemTime(issuedAt + 7 * 24 * 60 * 60 * 1000 + 1);
    const expired = await SELF.fetch("https://worker.test/v1/translate", {
      method: "POST",
      headers: {
        Origin: allowedOrigin,
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "CF-Connecting-IP": clientIp
      },
      body: JSON.stringify({ html: "<p>Hello</p>" })
    });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({
      error: { code: "session_expired" }
    });
  });
});
