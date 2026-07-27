import { SELF, env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const origin = "http://localhost:3000";
const baseTime = Date.UTC(2026, 6, 27, 12, 0, 0);

function headers(ip: string, token?: string): Record<string, string> {
  return {
    Origin: origin,
    "content-type": "application/json",
    "CF-Connecting-IP": ip,
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function issueSession(ip: string): Promise<string> {
  const response = await SELF.fetch("https://worker.test/v1/session", {
    method: "POST",
    headers: headers(ip),
    body: JSON.stringify({ turnstileToken: crypto.randomUUID() })
  });
  expect(response.status).toBe(201);
  return (await response.json<{ token: string }>()).token;
}

async function translate(token: string, ip: string): Promise<Response> {
  return SELF.fetch("https://worker.test/v1/translate", {
    method: "POST",
    headers: headers(ip, token),
    body: JSON.stringify({ html: "<p>Hello</p>" })
  });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("SQLite Durable Object quota ledger", () => {
  it("caps one IP at 150 daily calls while leaving global quota available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("siteverify")) {
          return Response.json({
            success: true,
            hostname: "localhost",
            action: "pet-ocr-session"
          });
        }
        return Response.json({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "<p>你好</p>" }] } }
          ],
          usageMetadata: {}
        });
      })
    );

    const token = await issueSession("203.0.113.40");
    for (let index = 0; index < 150; index += 1) {
      vi.setSystemTime(baseTime + Math.floor(index / 30) * 60_000);
      const response = await translate(token, "203.0.113.40");
      expect(response.status, `call ${index + 1}`).toBe(200);
    }

    vi.setSystemTime(baseTime + 5 * 60_000);
    const blocked = await translate(token, "203.0.113.40");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      error: { code: "ip_daily_limit_reached" }
    });

    const otherNetwork = await translate(token, "203.0.113.41");
    expect(otherNetwork.status).toBe(200);
    expect(
      (await otherNetwork.json<{ quota: { dailyRemaining: number } }>()).quota.dailyRemaining
    ).toBe(449);
  }, 30_000);

  it("caps a signed session at 200 upstream calls across different IPs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("siteverify")) {
          return Response.json({
            success: true,
            hostname: "localhost",
            action: "pet-ocr-session"
          });
        }
        return Response.json({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "<p>你好</p>" }] } }
          ],
          usageMetadata: {}
        });
      })
    );

    const token = await issueSession("198.51.100.1");
    for (let index = 0; index < 200; index += 1) {
      const ip = `198.51.100.${(index % 8) + 1}`;
      const response = await translate(token, ip);
      expect(response.status, `call ${index + 1}`).toBe(200);
    }

    const blocked = await translate(token, "198.51.100.9");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      error: {
        code: "session_limit_reached",
        message: expect.stringContaining("重新驗證")
      }
    });
  }, 30_000);

  it("limits one IP to 30 calls per minute and sends Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("siteverify")) {
          return Response.json({
            success: true,
            hostname: "localhost",
            action: "pet-ocr-session"
          });
        }
        return Response.json({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "<p>你好</p>" }] } }
          ],
          usageMetadata: {}
        });
      })
    );
    const token = await issueSession("192.0.2.50");

    for (let index = 0; index < 30; index += 1) {
      expect((await translate(token, "192.0.2.50")).status).toBe(200);
    }
    const blocked = await translate(token, "192.0.2.50");

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(await blocked.json()).toMatchObject({
      error: { code: "ip_rate_limit_reached" }
    });
  }, 15_000);

  it("atomically caps global daily calls and resets at Taiwan midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("siteverify")) {
          return Response.json({
            success: true,
            hostname: "localhost",
            action: "pet-ocr-session"
          });
        }
        return Response.json({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "<p>你好</p>" }] } }
          ],
          usageMetadata: {}
        });
      })
    );

    const testEnv = {
      ...(env as unknown as Env),
      DAILY_MAX_CALLS: "6"
    };
    const localFetch = (path: string, init: RequestInit) =>
      worker.fetch(new Request(`https://worker.test${path}`, init), testEnv);
    const session = await localFetch("/v1/session", {
      method: "POST",
      headers: headers("192.0.2.101"),
      body: JSON.stringify({ turnstileToken: "global-limit-test" })
    });
    const token = (await session.json<{ token: string }>()).token;

    for (let index = 0; index < 6; index += 1) {
      const response = await localFetch("/v1/translate", {
        method: "POST",
        headers: headers(`203.0.113.${100 + index}`, token),
        body: JSON.stringify({ html: "<p>Hello</p>" })
      });
      expect(response.status).toBe(200);
    }

    const blocked = await localFetch("/v1/translate", {
      method: "POST",
      headers: headers("203.0.113.200", token),
      body: JSON.stringify({ html: "<p>Hello</p>" })
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      error: { code: "daily_limit_reached" }
    });

    // baseTime is 20:00 in Taiwan. Four hours later is the next Taiwan day.
    vi.setSystemTime(baseTime + 4 * 60 * 60 * 1000);
    const nextDay = await localFetch("/v1/translate", {
      method: "POST",
      headers: headers("203.0.113.200", token),
      body: JSON.stringify({ html: "<p>Hello</p>" })
    });
    expect(nextDay.status).toBe(200);
    expect(
      (await nextDay.json<{ quota: { dailyRemaining: number } }>()).quota.dailyRemaining
    ).toBe(5);
  });

  it("preserves next-day global and IP counters when a lagging old-day request arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("siteverify")) {
          return Response.json({
            success: true,
            hostname: "localhost",
            action: "pet-ocr-session"
          });
        }
        return Response.json({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "<p>你好</p>" }] } }
          ],
          usageMetadata: {}
        });
      })
    );

    const testEnv = {
      ...(env as unknown as Env),
      DAILY_MAX_CALLS: "6"
    };
    const localFetch = (path: string, init: RequestInit) =>
      worker.fetch(new Request(`https://worker.test${path}`, init), testEnv);
    const session = await localFetch("/v1/session", {
      method: "POST",
      headers: headers("192.0.2.210"),
      body: JSON.stringify({ turnstileToken: "lagging-day-test" })
    });
    const token = (await session.json<{ token: string }>()).token;
    const call = () =>
      localFetch("/v1/translate", {
        method: "POST",
        headers: headers("203.0.113.210", token),
        body: JSON.stringify({ html: "<p>Hello</p>" })
      });

    // Establish counters on the next Taiwan calendar day.
    vi.setSystemTime(baseTime + 4 * 60 * 60 * 1000);
    const firstNextDay = await call();
    expect(firstNextDay.status).toBe(200);
    expect(
      await firstNextDay.json<{
        quota: { dailyRemaining: number; ipDailyRemaining: number };
      }>()
    ).toMatchObject({
      quota: { dailyRemaining: 5, ipDailyRemaining: 149 }
    });

    // A delayed request carrying the previous day's timestamp must not erase
    // already-created counters for the newer day.
    vi.setSystemTime(baseTime);
    expect((await call()).status).toBe(200);

    vi.setSystemTime(baseTime + 4 * 60 * 60 * 1000 + 1_000);
    const secondNextDay = await call();
    expect(secondNextDay.status).toBe(200);
    expect(
      await secondNextDay.json<{
        quota: { dailyRemaining: number; ipDailyRemaining: number };
      }>()
    ).toMatchObject({
      quota: { dailyRemaining: 4, ipDailyRemaining: 148 }
    });
  });
});
