import { SELF, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const origin = "http://localhost:3000";
const ip = "203.0.113.30";

async function issueSession(fetchStub: ReturnType<typeof vi.fn>): Promise<string> {
  vi.stubGlobal("fetch", fetchStub);
  const response = await SELF.fetch("https://worker.test/v1/session", {
    method: "POST",
    headers: {
      Origin: origin,
      "content-type": "application/json",
      "CF-Connecting-IP": ip
    },
    body: JSON.stringify({ turnstileToken: "challenge" })
  });
  expect(response.status).toBe(201);
  return (await response.json<{ token: string }>()).token;
}

function apiRequest(token: string, body: unknown, clientIp = ip): RequestInit {
  return {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "CF-Connecting-IP": clientIp
    },
    body: JSON.stringify(body)
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("server-controlled Gemini routes", () => {
  it("locks OCR model, prompt, output ceiling and minimal thinking", async () => {
    const usageMetadata = {
      promptTokenCount: 111,
      candidatesTokenCount: 222,
      thoughtsTokenCount: 3,
      totalTokenCount: 336,
      cachedContentTokenCount: 4,
      trafficType: "ON_DEMAND"
    };
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("siteverify")) {
        return Response.json({
          success: true,
          hostname: "localhost",
          action: "pet-ocr-session"
        });
      }

      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"
      );
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-gemini-key");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe("manual");
      const requestBody = JSON.parse(String(init?.body)) as {
        generationConfig: {
          maxOutputTokens: number;
          thinkingConfig: { thinkingLevel: string };
        };
        systemInstruction: { parts: Array<{ text: string }> };
        contents: Array<{
          parts: Array<{
            text?: string;
            inline_data?: { mime_type: string; data: string };
          }>;
        }>;
      };
      expect(requestBody.generationConfig).toEqual({
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: "minimal" }
      });
      expect(requestBody.systemInstruction.parts[0].text).toContain(
        "high-fidelity HTML"
      );
      expect(requestBody.contents[0].parts[0].text).toContain(
        "source image is 1280px wide"
      );
      expect(requestBody.contents[0].parts[1].inline_data).toEqual({
        mime_type: "image/png",
        data: "aW1hZ2U="
      });
      return Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "<main>OCR</main>" }] }
          }
        ],
        usageMetadata
      });
    });
    const token = await issueSession(upstream);

    const response = await SELF.fetch(
      "https://worker.test/v1/ocr",
      apiRequest(token, {
        image: { mimeType: "image/png", data: "aW1hZ2U=" },
        sourceWidth: 1280
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: "<main>OCR</main>",
      model: "gemini-3.5-flash-lite",
      usageMetadata,
      quota: {
        sessionRemaining: 199,
        ipDailyRemaining: 149,
        dailyRemaining: 599
      }
    });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("locks translation to Taiwan Traditional Chinese and preserves usage metadata", async () => {
    const usageMetadata = {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 1,
      totalTokenCount: 31,
      cachedContentTokenCount: 0
    };
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("siteverify")) {
        return Response.json({
          success: true,
          hostname: "localhost",
          action: "pet-ocr-session"
        });
      }
      const body = JSON.parse(String(init?.body));
      const prompt = body.contents[0].parts[0].text as string;
      expect(prompt).toContain("Target language: Traditional Chinese (Taiwan usage).");
      expect(prompt).toContain("Use Taiwan Traditional Chinese phrasing");
      expect(prompt).not.toContain("userSelectedLanguage");
      return Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "<p>你好</p>" }] }
          }
        ],
        usageMetadata
      });
    });
    const token = await issueSession(upstream);

    const response = await SELF.fetch(
      "https://worker.test/v1/translate",
      apiRequest(token, { html: "<p>Hello</p>" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "<p>你好</p>",
      usageMetadata
    });
  });

  it("keeps manual polish server-controlled and in Taiwan Traditional Chinese", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("siteverify")) {
        return Response.json({
          success: true,
          hostname: "localhost",
          action: "pet-ocr-session"
        });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig).toEqual({
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: "minimal" }
      });
      const prompt = body.contents[0].parts[0].text as string;
      expect(prompt).toContain("Three-Axis Quality Enhancement");
      expect(prompt).toContain("Taiwan-standard vocabulary");
      expect(prompt).toContain("<p>Hello</p>");
      expect(prompt).toContain("<p>哈囉</p>");
      return Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "<p>你好</p>" }] }
          }
        ],
        usageMetadata: { totalTokenCount: 42 }
      });
    });
    const token = await issueSession(upstream);

    const response = await SELF.fetch(
      "https://worker.test/v1/polish",
      apiRequest(token, {
        sourceHtml: "<p>Hello</p>",
        translatedHtml: "<p>哈囉</p>"
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "<p>你好</p>",
      model: "gemini-3.5-flash-lite"
    });
  });

  it("rejects invalid MIME and extra schema fields before quota or Gemini", async () => {
    let geminiCalls = 0;
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("siteverify")) {
        return Response.json({
          success: true,
          hostname: "localhost",
          action: "pet-ocr-session"
        });
      }
      geminiCalls += 1;
      return Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "<p>ok</p>" }] }
          }
        ],
        usageMetadata: {}
      });
    });
    const token = await issueSession(upstream);

    const badMime = await SELF.fetch(
      "https://worker.test/v1/ocr",
      apiRequest(token, {
        image: { mimeType: "text/html", data: "aW1hZ2U=" },
        sourceWidth: 100
      })
    );
    const extraField = await SELF.fetch(
      "https://worker.test/v1/translate",
      apiRequest(token, {
        html: "<p>Hello</p>",
        model: "attacker-controlled-model"
      })
    );
    const oversized = await SELF.fetch("https://worker.test/v1/translate", {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(16 * 1024 * 1024 + 1),
        "CF-Connecting-IP": ip
      },
      body: JSON.stringify({ html: "<p>Hello</p>" })
    });
    const good = await SELF.fetch(
      "https://worker.test/v1/translate",
      apiRequest(token, { html: "<p>Hello</p>" })
    );

    expect(badMime.status).toBe(415);
    expect(extraField.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(geminiCalls).toBe(1);
    expect((await good.json<{ quota: { sessionRemaining: number } }>()).quota)
      .toMatchObject({ sessionRemaining: 199 });
  });
});
