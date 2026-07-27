# Pet-OCR Gemini Proxy（Stage 1）

這個 Worker 是「圖片→中文」的後台邊界。它把 Gemini API Key、提示詞、模型與用量帳本留在 Cloudflare；前端只會拿到短期可撤銷的 HMAC session token。

目前已完成 Stage 1 Worker／SQLite Durable Object，以及 Stage 2 `圖片_to_中文.html` 前端串接與 mock 瀏覽器驗證。正式 Turnstile widget、三個 production Secret、Google 專案硬上限與 production Worker 均已設定；前端仍在隔離 worktree，尚未 commit／push／發布。

## 固定政策

- 模型：`gemini-3.5-flash-lite`
- 目標語言：`Traditional Chinese (Taiwan usage)`
- 每次輸出上限：`8192` tokens
- thinking：`minimal`
- session idle：24 小時
- session absolute：7 天
- 每 session：200 次
- 每 IP／分鐘：30 次
- 每 IP／台灣日：150 次
- 全站／台灣日：600 次
- 輸入上限：HTTP JSON 16 MiB；圖片解碼後 10 MiB

所有配額都在單一 SQLite Durable Object 內先 consume、再呼叫 Gemini。輸入驗證未通過不扣額度；一旦開始上游呼叫，錯誤、timeout 或取消都不退款。

## 前端契約

- 正式 Worker URL：`https://pet-ocr-gemini-proxy.lucky0623.workers.dev`
- session localStorage key：`pet_ocr_autofast_session`
- session 在 absolute expiry 前五分鐘主動重取
- Turnstile：explicit render、`execution: execute`、`appearance: interaction-only`、action `pet-ocr-session`
- `/v1/ocr`、`/v1/translate`、`/v1/polish` 只接受後端固定 schema；前端不再保存 prompt、Gemini Key 或模型選擇
- `401`／session 類錯誤會清 token、重驗一次並只重試一次；第二次仍失敗會再清 token
- 全站／IP 額度與 `quota_unavailable` 不清 token，也不觸發 Turnstile
- Gemini usageMetadata 原物件回到前端，費用面板持續讀五個既有欄位

`圖片_to_中文.html` 已寫入正式 Turnstile 公開 sitekey；它不是 Secret。Turnstile secret 僅存於 Cloudflare production Worker。

## 本機驗證

```powershell
npm install
npm run check
```

測試只使用假 Turnstile、假 Gemini 與假 Secret，不會呼叫真實服務。

## 開發／正式環境隔離

- 預設環境名稱：`pet-ocr-gemini-proxy-dev`
- 正式環境名稱：`pet-ocr-gemini-proxy`
- 正式 origin 僅允許 `https://kenkenno1.github.io`
- 正式環境不含 `localhost` 或 `127.0.0.1`
- dev 與 production 必須各自設定三個 Secret，不得共用值

開發環境 Secret：

```powershell
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put SESSION_HMAC_SECRET
```

正式環境 Secret：

```powershell
npx wrangler secret put GEMINI_API_KEY --env production
npx wrangler secret put TURNSTILE_SECRET_KEY --env production
npx wrangler secret put SESSION_HMAC_SECRET --env production
```

`SESSION_HMAC_SECRET` 至少 32 bytes，建議使用密碼學安全的隨機值。輪替後舊 token 會失效；Stage 2 前端必須清除舊 token，重新跑一次 Turnstile，不可無限重試。

## 部署紀錄與前端發布 gate

已完成：

1. Google Generative Language API 的 `gemini-3.5-flash-lite` paid tier 2 request quota：每分鐘 30 次、每日 600 次。
2. Turnstile managed widget：正式 hostname 僅 `kenkenno1.github.io`，action `pet-ocr-session`。
3. production Worker 三個 Secret：`GEMINI_API_KEY`、`TURNSTILE_SECRET_KEY`、`SESSION_HMAC_SECRET`。
4. `npm run check`、`wrangler deploy --dry-run`、前端 build、production Worker 部署與 `/healthz` 線上檢查。
5. 正式 GitHub Pages origin 的 CORS preflight 回 `204`；production 設定不含 localhost。

前端發布前仍需：

1. 對 deployment config、sitekey 接線與線上 Worker 證據做一次 Claude review。
2. 把隔離 worktree 的核准變更整合回 Pet-OCR repo，維持備份／scratch 不進 commit。
3. 等 GitHub Pages 新版回 `200` 後，再從正式網域做 Turnstile session 與一張真圖 smoke；`file://`／localhost 不屬於 production hostname，不能作為正式認證測試。
