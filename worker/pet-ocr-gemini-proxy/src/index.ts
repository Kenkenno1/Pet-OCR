import { DurableObject } from "cloudflare:workers";

export interface Env {
  ALLOWED_ORIGINS: string;
  APP_ENV: string;
  TURNSTILE_VERIFY_URL: string;
  TURNSTILE_EXPECTED_HOSTNAME: string;
  TURNSTILE_EXPECTED_ACTION: string;
  TURNSTILE_SECRET_KEY: string;
  SESSION_HMAC_SECRET: string;
  SESSION_IDLE_SECONDS: string;
  SESSION_ABSOLUTE_SECONDS: string;
  SESSION_MAX_CALLS: string;
  DAILY_MAX_CALLS: string;
  IP_DAILY_MAX_CALLS: string;
  IP_MINUTE_MAX_CALLS: string;
  GEMINI_API_KEY: string;
  GEMINI_BASE_URL: string;
  USAGE_GATE: DurableObjectNamespace<UsageGate>;
}

const API_ROUTES = new Set(["/v1/session", "/v1/ocr", "/v1/translate", "/v1/polish"]);
const SESSION_BODY_LIMIT = 16 * 1024;
const API_BODY_LIMIT = 16 * 1024 * 1024;
const IMAGE_BYTE_LIMIT = 10 * 1024 * 1024;
const LOCKED_MODEL = "gemini-3.5-flash-lite";
const LOCKED_TARGET_LANGUAGE = "Traditional Chinese (Taiwan usage)";
const MAX_OUTPUT_TOKENS = 8192;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif"
]);

interface SessionClaims {
  sid: string;
  iat: number;
  exp: number;
}

interface SessionRow {
  sid: string;
  createdAt: number;
  lastSeenAt: number;
  callsUsed: number;
}

interface QuotaLimits {
  idleMs: number;
  absoluteMs: number;
  sessionMax: number;
  dailyMax: number;
  ipDailyMax: number;
  ipMinuteMax: number;
}

type ConsumeResult =
  | {
      ok: true;
      sessionRemaining: number;
      dailyRemaining: number;
      ipDailyRemaining: number;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      retryAfter?: number;
    };

interface ParsedAiRequest {
  parts: Array<Record<string, unknown>>;
  systemInstruction: string;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowlist = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim());
  return allowlist.includes(origin) ? origin : null;
}

function corsHeaders(origin: string): Headers {
  const headers = new Headers();
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "600");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("vary", "Origin");
  return headers;
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(origin);
  cors.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status });
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function quotaLimits(env: Env): QuotaLimits {
  return {
    idleMs: positiveInteger(env.SESSION_IDLE_SECONDS, 86_400) * 1000,
    absoluteMs: positiveInteger(env.SESSION_ABSOLUTE_SECONDS, 604_800) * 1000,
    sessionMax: positiveInteger(env.SESSION_MAX_CALLS, 200),
    dailyMax: positiveInteger(env.DAILY_MAX_CALLS, 600),
    ipDailyMax: positiveInteger(env.IP_DAILY_MAX_CALLS, 150),
    ipMinuteMax: positiveInteger(env.IP_MINUTE_MAX_CALLS, 30)
  };
}

function hasCoreSessionConfiguration(env: Env): boolean {
  return (
    typeof env.SESSION_HMAC_SECRET === "string" &&
    env.SESSION_HMAC_SECRET.length >= 32 &&
    typeof env.USAGE_GATE?.getByName === "function"
  );
}

function hasSessionIssuanceConfiguration(env: Env): boolean {
  return (
    hasCoreSessionConfiguration(env) &&
    typeof env.TURNSTILE_SECRET_KEY === "string" &&
    env.TURNSTILE_SECRET_KEY.length > 0 &&
    typeof env.TURNSTILE_VERIFY_URL === "string" &&
    env.TURNSTILE_VERIFY_URL.startsWith("https://")
  );
}

function hasGeminiConfiguration(env: Env): boolean {
  return (
    hasCoreSessionConfiguration(env) &&
    typeof env.GEMINI_API_KEY === "string" &&
    env.GEMINI_API_KEY.length > 0 &&
    typeof env.GEMINI_BASE_URL === "string" &&
    env.GEMINI_BASE_URL.startsWith("https://")
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeJson(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (toBase64Url(bytes) !== value) throw new Error("non-canonical base64url");
  return bytes;
}

async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  const payload = encodeJson(claims);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

async function authenticateSession(
  request: Request,
  env: Env
): Promise<SessionClaims | Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return errorResponse(401, "session_required", "請先完成安全驗證。");
  }
  const token = authorization.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length !== 2) {
    return errorResponse(401, "session_invalid", "安全驗證已失效，請重新驗證。");
  }

  try {
    const payloadBytes = fromBase64Url(parts[0]);
    const signature = fromBase64Url(parts[1]);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.SESSION_HMAC_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(parts[0])
    );
    if (!valid) throw new Error("invalid signature");

    const claims = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<SessionClaims>;
    if (
      typeof claims.sid !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(claims.sid) ||
      typeof claims.iat !== "number" ||
      !Number.isSafeInteger(claims.iat) ||
      typeof claims.exp !== "number" ||
      !Number.isSafeInteger(claims.exp)
    ) {
      throw new Error("invalid claims");
    }
    if (claims.exp <= Date.now()) {
      return errorResponse(401, "session_expired", "安全驗證已逾時，請重新驗證。");
    }
    return claims as SessionClaims;
  } catch {
    return errorResponse(401, "session_invalid", "安全驗證已失效，請重新驗證。");
  }
}

async function readSessionBody(request: Request): Promise<{ turnstileToken: string } | Response> {
  const value = await readJsonWithLimit(request, SESSION_BODY_LIMIT);
  if (value instanceof Response) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return errorResponse(400, "invalid_request", "驗證資料格式不正確。");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 1 ||
    keys[0] !== "turnstileToken" ||
    typeof record.turnstileToken !== "string" ||
    record.turnstileToken.length < 1 ||
    record.turnstileToken.length > 2048
  ) {
    return errorResponse(400, "invalid_request", "驗證資料格式不正確。");
  }
  return { turnstileToken: record.turnstileToken };
}

async function readJsonWithLimit(request: Request, limit: number): Promise<unknown | Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return errorResponse(415, "unsupported_media_type", "請使用 JSON 格式送出資料。");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > limit) {
    return errorResponse(413, "request_too_large", "上傳資料超過大小上限。");
  }
  if (!request.body) {
    return errorResponse(400, "invalid_json", "缺少請求內容。");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return errorResponse(413, "request_too_large", "上傳資料超過大小上限。");
      }
      chunks.push(value);
    }
  } catch {
    return errorResponse(400, "invalid_body", "無法讀取請求內容。");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return errorResponse(400, "invalid_json", "請求內容不是有效的 JSON。");
  }
}

function hasExactKeys(record: Record<string, unknown>, allowed: string[], required: string[]): boolean {
  const keys = Object.keys(record);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function normalizeSourceWidth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(320, Math.min(2200, Math.round(value)));
}

function validBase64Image(data: string): boolean {
  if (data.length === 0 || data.length > Math.ceil((IMAGE_BYTE_LIMIT * 4) / 3) + 4) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 !== 0) return false;
  try {
    return atob(data).length <= IMAGE_BYTE_LIMIT;
  } catch {
    return false;
  }
}

function buildOcrRequest(value: unknown): ParsedAiRequest | Response {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return errorResponse(400, "invalid_request", "OCR 請求格式不正確。");
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["image", "sourceWidth"], ["image"])) {
    return errorResponse(400, "invalid_request", "OCR 請求包含不支援的欄位。");
  }
  if (!record.image || typeof record.image !== "object" || Array.isArray(record.image)) {
    return errorResponse(400, "invalid_request", "缺少有效的圖片資料。");
  }
  const image = record.image as Record<string, unknown>;
  if (
    !hasExactKeys(image, ["mimeType", "data"], ["mimeType", "data"]) ||
    typeof image.mimeType !== "string" ||
    typeof image.data !== "string"
  ) {
    return errorResponse(400, "invalid_request", "圖片資料格式不正確。");
  }
  if (!ALLOWED_IMAGE_MIME_TYPES.has(image.mimeType)) {
    return errorResponse(415, "unsupported_image_type", "不支援此圖片格式。");
  }
  if (!validBase64Image(image.data)) {
    return errorResponse(413, "invalid_image_data", "圖片資料無效或超過 10 MiB 上限。");
  }

  const sourceWidth = normalizeSourceWidth(record.sourceWidth);
  if (record.sourceWidth !== undefined && sourceWidth === null) {
    return errorResponse(400, "invalid_request", "圖片寬度格式不正確。");
  }
  const widthContract = sourceWidth
    ? `\n6. The source image is ${sourceWidth}px wide. Wrap the entire reconstruction in exactly one outermost wrapper element with inline style="width: ${sourceWidth}px; margin: 0; box-sizing: border-box;". Use this exact pixel width and zero outer margins on that wrapper. Lay out the reconstruction across the available wrapper width according to the source image proportions; do not place the document inside a narrower column or leave artificial unused horizontal whitespace. Do not use %, vw, max-width, fit-content, or a narrower centered wrapper for the outermost document.`
    : "";
  const outputRuleNumber = sourceWidth ? 7 : 6;
  const prompt = `Convert this image to high-fidelity HTML.
Rules:
1. Use inline CSS for layout (flex/grid).
2. Match colors, fonts, and positions as closely as possible.
3. Preserve horizontal text as horizontal text. Japanese/Chinese/Korean language alone is NOT evidence of vertical writing.
4. Use CSS "writing-mode: vertical-rl" ONLY when the source image visibly shows top-to-bottom vertical columns. For ordinary news pages, lists, headlines, cards, captions, and paragraphs arranged in left-to-right horizontal rows, DO NOT use writing-mode or narrow one-character columns.
5. Avoid artificial narrow columns: give each text block enough width for normal words/phrases to wrap naturally.${widthContract}
${outputRuleNumber}. Return ONLY raw HTML string. No markdown, no code fences.`;
  return {
    systemInstruction:
      "You are an expert Frontend Developer specializing in converting images to high-fidelity HTML.",
    parts: [
      { text: prompt },
      { inline_data: { mime_type: image.mimeType, data: image.data } }
    ]
  };
}

function buildTranslateRequest(value: unknown): ParsedAiRequest | Response {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return errorResponse(400, "invalid_request", "翻譯請求格式不正確。");
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["html"], ["html"]) ||
    typeof record.html !== "string" ||
    record.html.trim().length === 0
  ) {
    return errorResponse(400, "invalid_request", "翻譯請求包含不支援的欄位或空白內容。");
  }
  const prompt = `Target language: ${LOCKED_TARGET_LANGUAGE}.
Source HTML:
${record.html}
Rules:
1. Keep all HTML structure, classes, and inline styles EXACTLY the same.
2. Only translate visible text content.
3. Use Taiwan Traditional Chinese phrasing (not Mainland China/HK usage).
4. Return ONLY raw HTML string. No markdown, no code fences.`;
  return {
    systemInstruction:
      "You are a Localization Engineer. Your job is to translate HTML content while preserving all markup structure exactly.",
    parts: [{ text: prompt }]
  };
}

function buildPolishRequest(value: unknown): ParsedAiRequest | Response {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return errorResponse(400, "invalid_request", "潤稿請求格式不正確。");
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["sourceHtml", "translatedHtml"], ["sourceHtml", "translatedHtml"]) ||
    typeof record.sourceHtml !== "string" ||
    typeof record.translatedHtml !== "string" ||
    !record.sourceHtml.trim() ||
    !record.translatedHtml.trim()
  ) {
    return errorResponse(400, "invalid_request", "潤稿請求包含不支援的欄位或空白內容。");
  }
  const prompt = `Target language: ${LOCKED_TARGET_LANGUAGE}.
The revised translation MUST remain entirely in ${LOCKED_TARGET_LANGUAGE}. Never rewrite it into any other language. If any part of the current translation is in the wrong language, translate that part into ${LOCKED_TARGET_LANGUAGE}.

## Step 1: Deep Comprehension
First, carefully re-read the source text to fully understand:
- The overall meaning, intent, and nuance of the original
- Any domain-specific terminology or context
- The tone, register, and rhetorical purpose

## Source HTML (original text):
${record.sourceHtml}

## Current Translation (target language: ${LOCKED_TARGET_LANGUAGE}):
${record.translatedHtml}

## Step 2: Three-Axis Quality Enhancement
Revise the translation along these three axes:

### Axis 1 — Precision
- Fix any mistranslations, omissions, or additions
- Ensure numbers, proper nouns, and technical terms are correct
- Verify that the meaning faithfully reflects the source

### Axis 2 — Localization
- Use natural phrasing for the target locale of ${LOCKED_TARGET_LANGUAGE}
- For Traditional Chinese (Taiwan): use Taiwan-standard vocabulary, measure words, and expressions; strictly avoid Mainland China or Hong Kong phrasing
- Adapt cultural references, units, or idioms appropriately for the target audience

### Axis 3 — Fluency & Naturalness
- Ensure the text reads as if originally written in ${LOCKED_TARGET_LANGUAGE}
- Improve sentence rhythm, flow, and cohesion
- Remove translationese — awkward calques, unnatural word order, or overly literal constructions
- Maintain consistency in style and tone throughout

## Output Rules:
1. Keep ALL HTML structure, tags, classes, and inline styles EXACTLY the same as the current translation
2. Only modify the visible text content
3. The output language MUST be ${LOCKED_TARGET_LANGUAGE}
4. Return ONLY the revised raw HTML string. No markdown, no code fences, no explanations.`;
  return {
    systemInstruction:
      "You are a senior translation editor and quality assurance specialist. Your job is to polish and elevate existing translations through deep revision along three axes: Precision, Localization, and Fluency. You always keep the translation in its designated target language — never switch languages.",
    parts: [{ text: prompt }]
  };
}

async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function taiwanDay(now: number): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function quotaError(result: Exclude<ConsumeResult, { ok: true }>): Response {
  const headers = new Headers();
  if (result.retryAfter) headers.set("retry-after", String(result.retryAfter));
  return json(
    { error: { code: result.code, message: result.message } },
    { status: result.status, headers }
  );
}

function extractGeminiText(data: Record<string, unknown>): string | Response {
  const candidates = data.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return errorResponse(502, "model_no_output", "模型沒有回傳可用內容。");
  }
  const firstCandidate = candidates[0];
  if (!firstCandidate || typeof firstCandidate !== "object" || Array.isArray(firstCandidate)) {
    return errorResponse(502, "model_invalid_response", "翻譯服務回傳了無效資料。");
  }
  const candidate = firstCandidate as Record<string, unknown>;
  if (candidate.finishReason === "MAX_TOKENS") {
    return errorResponse(502, "model_output_truncated", "模型回應達到長度上限，內容不完整。");
  }
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    return errorResponse(502, "model_output_filtered", "模型未能完成此內容。");
  }
  const content = candidate.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return errorResponse(502, "model_invalid_response", "翻譯服務回傳了無效資料。");
  }
  const parts = (content as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) {
    return errorResponse(502, "model_invalid_response", "翻譯服務回傳了無效資料。");
  }
  const text = parts
    .map((part) =>
      part && typeof part === "object" && !Array.isArray(part) &&
      typeof (part as Record<string, unknown>).text === "string"
        ? ((part as Record<string, unknown>).text as string)
        : ""
    )
    .join("")
    .trim();
  if (!text) return errorResponse(502, "model_no_output", "模型沒有回傳可用內容。");
  return text.replace(/```html|```/gu, "").trim();
}

async function handleAiRoute(
  request: Request,
  env: Env,
  path: string,
  claims: SessionClaims
): Promise<Response> {
  const parsedBody = await readJsonWithLimit(request, API_BODY_LIMIT);
  if (parsedBody instanceof Response) return parsedBody;

  const prepared =
    path === "/v1/ocr"
      ? buildOcrRequest(parsedBody)
      : path === "/v1/translate"
        ? buildTranslateRequest(parsedBody)
        : buildPolishRequest(parsedBody);
  if (prepared instanceof Response) return prepared;

  if (request.signal.aborted) {
    return errorResponse(499, "request_aborted", "請求已取消。");
  }
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return errorResponse(400, "client_ip_missing", "無法確認連線來源，請稍後再試。");

  const now = Date.now();
  const limits = quotaLimits(env);
  const gate = env.USAGE_GATE.getByName("global", { locationHint: "apac" });
  let consumed: ConsumeResult;
  try {
    consumed = await gate.consume({
      sid: claims.sid,
      now,
      day: taiwanDay(now),
      minuteBucket: Math.floor(now / 60_000),
      ipHash: await hmacHex(ip, env.SESSION_HMAC_SECRET),
      limits
    });
  } catch {
    return errorResponse(503, "quota_unavailable", "用量控管服務暫時無法使用，請稍後再試。");
  }
  if (!consumed.ok) return quotaError(consumed);

  const upstreamUrl = `${env.GEMINI_BASE_URL}/models/${LOCKED_MODEL}:generateContent`;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prepared.systemInstruction }] },
        contents: [{ parts: prepared.parts }],
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig: { thinkingLevel: "minimal" }
        }
      }),
      redirect: "manual",
      signal: request.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return errorResponse(499, "request_aborted", "請求已取消。");
    }
    return errorResponse(502, "model_unavailable", "翻譯服務暫時無法連線，請稍後再試。");
  }

  if (!upstream.ok) {
    const retryable = [429, 502, 503, 504].includes(upstream.status);
    const headers = new Headers();
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers.set("retry-after", retryAfter);
    return json(
      {
        error: {
          code: retryable ? "model_busy" : "model_request_failed",
          message: retryable ? "翻譯服務忙碌中，請稍後再試。" : "翻譯服務無法處理此請求。",
          retryable
        }
      },
      { status: retryable ? 503 : 502, headers }
    );
  }

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = await upstream.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errorResponse(502, "model_invalid_response", "翻譯服務回傳了無效資料。");
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return errorResponse(502, "model_invalid_response", "翻譯服務回傳了無效資料。");
  }
  const text = extractGeminiText(data);
  if (text instanceof Response) return text;

  return json({
    text,
    model: LOCKED_MODEL,
    usageMetadata:
      data.usageMetadata && typeof data.usageMetadata === "object" ? data.usageMetadata : {},
    quota: {
      sessionRemaining: consumed.sessionRemaining,
      ipDailyRemaining: consumed.ipDailyRemaining,
      dailyRemaining: consumed.dailyRemaining
    }
  });
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  const parsed = await readSessionBody(request);
  if (parsed instanceof Response) return parsed;

  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) {
    return errorResponse(400, "client_ip_missing", "無法確認連線來源，請稍後再試。");
  }

  const fields = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: parsed.turnstileToken,
    remoteip: ip
  });

  let verification: {
    success?: boolean;
    hostname?: string;
    action?: string;
  };
  try {
    const upstream = await fetch(env.TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields.toString(),
      signal: request.signal
    });
    if (!upstream.ok) {
      return errorResponse(503, "turnstile_unavailable", "驗證服務暫時無法使用，請稍後再試。");
    }
    const parsed: unknown = await upstream.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errorResponse(503, "turnstile_unavailable", "驗證服務暫時無法使用，請稍後再試。");
    }
    verification = parsed as typeof verification;
  } catch {
    return errorResponse(503, "turnstile_unavailable", "驗證服務暫時無法使用，請稍後再試。");
  }

  if (
    verification.success !== true ||
    verification.hostname !== env.TURNSTILE_EXPECTED_HOSTNAME ||
    verification.action !== env.TURNSTILE_EXPECTED_ACTION
  ) {
    return errorResponse(403, "turnstile_failed", "驗證未通過，請重新驗證。");
  }

  const now = Date.now();
  const idleMs = positiveInteger(env.SESSION_IDLE_SECONDS, 86_400) * 1000;
  const absoluteMs = positiveInteger(env.SESSION_ABSOLUTE_SECONDS, 604_800) * 1000;
  const sid = crypto.randomUUID();
  const claims: SessionClaims = { sid, iat: now, exp: now + absoluteMs };
  const gate = env.USAGE_GATE.getByName("global", { locationHint: "apac" });
  try {
    await gate.createSession({ sid, now });
  } catch {
    return errorResponse(503, "quota_unavailable", "用量控管服務暫時無法使用，請稍後再試。");
  }

  return json(
    {
      token: await signSession(claims, env.SESSION_HMAC_SECRET),
      expiresAt: claims.exp,
      idleExpiresAt: now + idleMs,
      limits: {
        sessionCalls: positiveInteger(env.SESSION_MAX_CALLS, 200)
      }
    },
    { status: 201 }
  );
}

export class UsageGate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        calls_used INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS daily_usage (
        day TEXT PRIMARY KEY,
        calls_used INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ip_daily_usage (
        day TEXT NOT NULL,
        ip_hash TEXT NOT NULL,
        calls_used INTEGER NOT NULL,
        PRIMARY KEY (day, ip_hash)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ip_minute_usage (
        minute_bucket INTEGER NOT NULL,
        ip_hash TEXT NOT NULL,
        calls_used INTEGER NOT NULL,
        PRIMARY KEY (minute_bucket, ip_hash)
      )
    `);
  }

  createSession(input: { sid: string; now: number }): SessionRow {
    return this.ctx.storage.transactionSync(() => {
      const absoluteMs = positiveInteger(this.env.SESSION_ABSOLUTE_SECONDS, 604_800) * 1000;
      this.ctx.storage.sql.exec(
        "DELETE FROM sessions WHERE created_at < ?",
        input.now - absoluteMs
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO sessions (sid, created_at, last_seen_at, calls_used) VALUES (?, ?, ?, 0)",
        input.sid,
        input.now,
        input.now
      );
      return {
        sid: input.sid,
        createdAt: input.now,
        lastSeenAt: input.now,
        callsUsed: 0
      };
    });
  }

  consume(input: {
    sid: string;
    now: number;
    day: string;
    minuteBucket: number;
    ipHash: string;
    limits: QuotaLimits;
  }): ConsumeResult {
    return this.ctx.storage.transactionSync(() => {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM sessions WHERE created_at < ?", input.now - input.limits.absoluteMs);
    sql.exec("DELETE FROM daily_usage WHERE day < ?", input.day);
    sql.exec("DELETE FROM ip_daily_usage WHERE day < ?", input.day);
    sql.exec(
      "DELETE FROM ip_minute_usage WHERE minute_bucket < ?",
      input.minuteBucket - 2
    );

    const session = sql
      .exec<{
        created_at: number;
        last_seen_at: number;
        calls_used: number;
      }>(
        "SELECT created_at, last_seen_at, calls_used FROM sessions WHERE sid = ?",
        input.sid
      )
      .toArray()[0];
    if (!session) {
      return {
        ok: false,
        status: 401,
        code: "session_invalid",
        message: "安全驗證已失效，請重新驗證。"
      };
    }
    if (
      input.now - session.last_seen_at > input.limits.idleMs ||
      input.now - session.created_at > input.limits.absoluteMs
    ) {
      sql.exec("DELETE FROM sessions WHERE sid = ?", input.sid);
      return {
        ok: false,
        status: 401,
        code: "session_expired",
        message: "安全驗證已逾時，請重新驗證。"
      };
    }
    if (session.calls_used >= input.limits.sessionMax) {
      return {
        ok: false,
        status: 429,
        code: "session_limit_reached",
        message: "本次旅程用量已達上限，請重新驗證取得新的額度。"
      };
    }

    const daily =
      sql
        .exec<{ calls_used: number }>(
          "SELECT calls_used FROM daily_usage WHERE day = ?",
          input.day
        )
        .toArray()[0]?.calls_used ?? 0;
    if (daily >= input.limits.dailyMax) {
      return {
        ok: false,
        status: 429,
        code: "daily_limit_reached",
        message: "今日全站翻譯額度已用完，請於台灣時間午夜後再試。"
      };
    }

    const ipDaily =
      sql
        .exec<{ calls_used: number }>(
          "SELECT calls_used FROM ip_daily_usage WHERE day = ? AND ip_hash = ?",
          input.day,
          input.ipHash
        )
        .toArray()[0]?.calls_used ?? 0;
    if (ipDaily >= input.limits.ipDailyMax) {
      return {
        ok: false,
        status: 429,
        code: "ip_daily_limit_reached",
        message: "此網路今日翻譯額度已用完，請明天或更換網路後再試。"
      };
    }

    const ipMinute =
      sql
        .exec<{ calls_used: number }>(
          "SELECT calls_used FROM ip_minute_usage WHERE minute_bucket = ? AND ip_hash = ?",
          input.minuteBucket,
          input.ipHash
        )
        .toArray()[0]?.calls_used ?? 0;
    if (ipMinute >= input.limits.ipMinuteMax) {
      const retryAfter = 60 - Math.floor((input.now % 60_000) / 1000);
      return {
        ok: false,
        status: 429,
        code: "ip_rate_limit_reached",
        message: "請求速度太快，請稍候再試。",
        retryAfter
      };
    }

    sql.exec(
      "UPDATE sessions SET last_seen_at = ?, calls_used = calls_used + 1 WHERE sid = ?",
      input.now,
      input.sid
    );
    sql.exec(
      `INSERT INTO daily_usage (day, calls_used) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET calls_used = calls_used + 1`,
      input.day
    );
    sql.exec(
      `INSERT INTO ip_daily_usage (day, ip_hash, calls_used) VALUES (?, ?, 1)
       ON CONFLICT(day, ip_hash) DO UPDATE SET calls_used = calls_used + 1`,
      input.day,
      input.ipHash
    );
    sql.exec(
      `INSERT INTO ip_minute_usage (minute_bucket, ip_hash, calls_used) VALUES (?, ?, 1)
       ON CONFLICT(minute_bucket, ip_hash) DO UPDATE SET calls_used = calls_used + 1`,
      input.minuteBucket,
      input.ipHash
    );

    return {
      ok: true,
      sessionRemaining: input.limits.sessionMax - session.calls_used - 1,
      dailyRemaining: input.limits.dailyMax - daily - 1,
      ipDailyRemaining: input.limits.ipDailyMax - ipDaily - 1
    };
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({
        ok: true,
        service: "pet-ocr-gemini-proxy"
      });
    }

    if (API_ROUTES.has(url.pathname)) {
      const origin = allowedOrigin(request, env);
      if (!origin) {
        return json(
          { error: { code: "origin_forbidden", message: "此來源未獲授權。" } },
          { status: 403 }
        );
      }

      const headers = corsHeaders(origin);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== "POST") {
        headers.set("allow", "POST, OPTIONS");
        return json(
          { error: { code: "method_not_allowed", message: "此路徑僅接受 POST。" } },
          { status: 405, headers }
        );
      }

      if (url.pathname === "/v1/session") {
        if (!hasSessionIssuanceConfiguration(env)) {
          return withCors(
            errorResponse(503, "service_not_configured", "服務尚未完成安全設定。"),
            origin
          );
        }
        return withCors(await handleSession(request, env), origin);
      }

      if (!hasGeminiConfiguration(env)) {
        return withCors(
          errorResponse(503, "service_not_configured", "服務尚未完成安全設定。"),
          origin
        );
      }
      const authentication = await authenticateSession(request, env);
      if (authentication instanceof Response) {
        return withCors(authentication, origin);
      }

      return withCors(
        await handleAiRoute(request, env, url.pathname, authentication),
        origin
      );
    }

    return json({ error: { code: "not_found", message: "找不到此服務路徑。" } }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;
