import { SELF, env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const origin = "http://localhost:3000";
const ip = "203.0.113.80";

function requestHeaders(token?: string): Record<string, string> {
  return {
    Origin: origin,
    "content-type": "application/json",
    "CF-Connecting-IP": ip,
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function issueSession(upstream: ReturnType<typeof vi.fn>): Promise<string> {
  vi.stubGlobal("fetch", upstream);
  const response = await SELF.fetch("https://worker.test/v1/session", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({ turnstileToken: "challenge" })
  });
  return (await response.json<{ token: string }>()).token;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("failure containment", () => {
  it("fails closed before Siteverify when required secrets are missing", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const missingSecretEnv = {
      ...(env as unknown as Env),
      TURNSTILE_SECRET_KEY: ""
    };

    const response = await worker.fetch(
      new Request("https://worker.test/v1/session", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ turnstileToken: "challenge" })
      }),
      missingSecretEnv
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "service_not_configured" }
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns a controlled error when session persistence is unavailable", async () => {
    const upstream = vi.fn(async () =>
      Response.json({
        success: true,
        hostname: "localhost",
        action: "pet-ocr-session"
      })
    );
    vi.stubGlobal("fetch", upstream);
    const unavailableNamespace = {
      getByName() {
        return {
          async createSession() {
            throw new Error("DO unavailable");
          }
        };
      }
    } as unknown as Env["USAGE_GATE"];
    const failingEnv = {
      ...(env as unknown as Env),
      USAGE_GATE: unavailableNamespace
    };

    const response = await worker.fetch(
      new Request("https://worker.test/v1/session", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ turnstileToken: "challenge" })
      }),
      failingEnv
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "quota_unavailable" }
    });
  });

  it("does not retry or expose upstream details on a Gemini 503", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("siteverify")) {
        return Response.json({
          success: true,
          hostname: "localhost",
          action: "pet-ocr-session"
        });
      }
      return Response.json(
        { error: { message: "secret test-gemini-key internal upstream detail" } },
        { status: 503, headers: { "retry-after": "7" } }
      );
    });
    const token = await issueSession(upstream);

    const response = await SELF.fetch("https://worker.test/v1/translate", {
      method: "POST",
      headers: requestHeaders(token),
      body: JSON.stringify({ html: "<p>Hello</p>" })
    });
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(text).not.toContain("test-gemini-key");
    expect(text).not.toContain("internal upstream detail");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("normalizes a MAX_TOKENS response as an incomplete-output error", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("siteverify")) {
        return Response.json({
          success: true,
          hostname: "localhost",
          action: "pet-ocr-session"
        });
      }
      return Response.json({
        candidates: [
          {
            finishReason: "MAX_TOKENS",
            content: { parts: [{ text: "<p>partial" }] }
          }
        ],
        usageMetadata: { totalTokenCount: 8192 }
      });
    });
    const token = await issueSession(upstream);

    const response = await SELF.fetch("https://worker.test/v1/translate", {
      method: "POST",
      headers: requestHeaders(token),
      body: JSON.stringify({ html: "<p>Hello</p>" })
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "model_output_truncated" }
    });
  });

  it("contains a structurally invalid Siteverify JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(null)));

    const response = await SELF.fetch("https://worker.test/v1/session", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ turnstileToken: "challenge" })
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "turnstile_unavailable" }
    });
  });

  it("contains a structurally invalid Gemini JSON response", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("siteverify")) {
        return Response.json({
          success: true,
          hostname: "localhost",
          action: "pet-ocr-session"
        });
      }
      return Response.json(null);
    });
    const token = await issueSession(upstream);

    const response = await SELF.fetch("https://worker.test/v1/translate", {
      method: "POST",
      headers: requestHeaders(token),
      body: JSON.stringify({ html: "<p>Hello</p>" })
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "model_invalid_response" }
    });
  });
});
