import { SELF, env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const origin = "http://localhost:3000";

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("quota ledger availability", () => {
  it("fails closed and never calls Gemini when the Durable Object is unavailable", async () => {
    const upstream = vi.fn(async () =>
      Response.json({
        success: true,
        hostname: "localhost",
        action: "pet-ocr-session"
      })
    );
    vi.stubGlobal("fetch", upstream);
    const session = await SELF.fetch("https://worker.test/v1/session", {
      method: "POST",
      headers: {
        Origin: origin,
        "content-type": "application/json",
        "CF-Connecting-IP": "203.0.113.70"
      },
      body: JSON.stringify({ turnstileToken: "challenge" })
    });
    const token = (await session.json<{ token: string }>()).token;

    const unavailableNamespace = {
      getByName() {
        return {
          async consume() {
            throw new Error("Durable Object unavailable");
          }
        };
      }
    } as unknown as Env["USAGE_GATE"];
    const failingEnv = {
      ...(env as unknown as Env),
      USAGE_GATE: unavailableNamespace
    };
    const response = await worker.fetch(
      new Request("https://worker.test/v1/translate", {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "CF-Connecting-IP": "203.0.113.70"
        },
        body: JSON.stringify({ html: "<p>Hello</p>" })
      }),
      failingEnv
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "quota_unavailable" }
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
