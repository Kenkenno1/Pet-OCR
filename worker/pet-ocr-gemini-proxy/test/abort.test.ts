import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const origin = "http://localhost:3000";
const ip = "203.0.113.60";

function headers(token?: string): Record<string, string> {
  return {
    Origin: origin,
    "content-type": "application/json",
    "CF-Connecting-IP": ip,
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("client cancellation contract", () => {
  it("aborts the in-flight Gemini fetch and does not refund the consumed call", async () => {
    let geminiCalls = 0;
    let upstreamSawAbort = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("siteverify")) {
          return Response.json({
            success: true,
            hostname: "localhost",
            action: "pet-ocr-session"
          });
        }
        geminiCalls += 1;
        if (geminiCalls === 1) {
          markStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                upstreamSawAbort = true;
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true }
            );
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

    const testEnv = env as unknown as Env;
    const localFetch = (path: string, init: RequestInit) =>
      worker.fetch(new Request(`https://worker.test${path}`, init), testEnv);
    const session = await localFetch("/v1/session", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ turnstileToken: "challenge" })
    });
    const token = (await session.json<{ token: string }>()).token;

    const controller = new AbortController();
    const cancelledRequest = localFetch("/v1/translate", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ html: "<p>Hello</p>" }),
      signal: controller.signal
    });
    await started;
    controller.abort();
    await cancelledRequest.catch(() => undefined);

    expect(upstreamSawAbort).toBe(true);
    const next = await localFetch("/v1/translate", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ html: "<p>Hello again</p>" })
    });
    expect(next.status).toBe(200);
    expect(
      (await next.json<{ quota: { sessionRemaining: number } }>()).quota.sessionRemaining
    ).toBe(198);
  });
});
