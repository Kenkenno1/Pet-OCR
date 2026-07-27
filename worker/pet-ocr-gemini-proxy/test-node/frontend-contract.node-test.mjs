import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const htmlPath = fileURLToPath(new URL("../../../圖片_to_中文.html", import.meta.url));
const html = await readFile(htmlPath, "utf8");

test("frontend compiles and never exposes or reads a Gemini API key", () => {
  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu)]
    .map((match) => match[1])
    .join("\n");
  assert.doesNotThrow(() => new Function(inlineScripts));

  for (const forbidden of [
    "generativelanguage.googleapis.com",
    "x-goog-api-key",
    'id="api-key-input"',
    "ocr_gemini_api_key",
    "ocr_gemini_model",
    "ocr_target_language",
    "ocr_polish_enabled"
  ]) {
    assert.equal(html.includes(forbidden), false, `forbidden frontend artifact: ${forbidden}`);
  }
});

test("frontend locks the approved Worker session and Turnstile contract", () => {
  assert.match(html, /pet_ocr_autofast_session/u);
  assert.match(html, /https:\/\/pet-ocr-gemini-proxy\.lucky0623\.workers\.dev/u);
  assert.match(html, /\/v1\/session/u);
  assert.match(html, /callBackendAiRoute\('ocr'/u);
  assert.match(html, /callBackendAiRoute\('translate'/u);
  assert.match(html, /callBackendAiRoute\(\s*'polish'/u);
  assert.match(html, /action:\s*TURNSTILE_ACTION/u);
  assert.match(html, /execution:\s*'execute'/u);
  assert.match(html, /appearance:\s*'interaction-only'/u);
});

test("frontend preserves sanitizer, immediate fit-page and the UFO OCR seam", () => {
  assert.match(html, /function sanitizeHtml\(/u);
  assert.match(html, /function sanitizeInlineStyle\(/u);
  assert.match(html, /function sanitizeUrlAttribute\(/u);
  assert.match(
    html,
    /updateZoomUI\(cardId\);\s*applyCardZoom\(cardId\);/u
  );
  assert.match(
    html,
    /getItemSourceWidthForOcr\(item\)[\s\S]*?armUfoTimer\(signal\)[\s\S]*?try\s*\{[\s\S]*?callGeminiOCR\([\s\S]*?\}\s*finally\s*\{\s*disarmUfo\(\);/u
  );
  assert.match(html, /cleanupUfoEasterEgg\(\); \/\/ 批次結束/u);
});
