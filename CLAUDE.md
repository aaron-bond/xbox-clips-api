# CLAUDE.md

Fast way back into this repo. [PLAN-v1.md](PLAN-v1.md) is the authoritative
design, with the reasoning for every decision; this file is the map and the
rules that must not be broken.

## What this is

A Cloudflare Worker (Hono, TypeScript strict) serving Xbox game clips for any
gamertag, with no login. One server-side OpenXBL personal key; Workers KV as a
response cache; the browser streams media straight from the Xbox CDN.

## Map

| Path | Role |
| :--- | :--- |
| `src/index.ts` | Entry point: wires the real provider into the app. |
| `src/app.ts` | Routes, CORS, inbound rate limit, error envelope. `createApp({ provider, now })`. |
| `src/service.ts` | `ClipService`: cache policy (`POLICY`), cache keys, clip resolution. |
| `src/cache.ts` | KV wrapper: freshness window, retention, stale fallback. |
| `src/provider/types.ts` | `IXboxDataProvider`, the only seam to upstream. |
| `src/provider/openxbl.ts` | HTTP client: envelope, status mapping, logging. |
| `src/provider/openxbl-transform.ts` | Raw payload → domain types. Raw shapes documented here. |
| `src/domain.ts` | Domain types. Nothing outside `src/provider/` sees raw payloads. |
| `src/origins.ts` | CORS allow-list matching, including `https://*.host` wildcards. |
| `src/validation.ts`, `src/errors.ts` | Input validation; public error codes. |
| `test/` | Vitest in the Workers runtime. `FakeProvider` replaces upstream. |

## Invariants

- **Stateless and pass-through.** Never proxy, download or store clip media,
  now or later. KV holds short-lived JSON only. (PLAN §3)
- **Never serve a media URL past its `expiration`.** URLs last one hour from
  fetch. The clips entry is fresh only until 5 minutes before its earliest
  URL expires, and the stale path strips expired URLs. (PLAN §3, §5)
- **Cache the full list; slice per request.** `limit` never touches the cache
  key or the stored value. (PLAN §3)
- **The API key is a call-time argument** to the provider, never constructor
  state. (PLAN §3)
- **Upstream error text never reaches clients.** Log it; return the fixed
  message for the code. (PLAN §3, §6)
- **Validate every identifier** before it reaches a cache key or URL.
- **Gamertag search is fuzzy.** Only an exact (case-insensitive) match counts;
  never take the first result.
- **Encode KV values exactly once.** `JSON.stringify` on put, `get(key, 'json')`
  on read.

## Working rules

- **The upstream budget is 150 requests/hour, shared** by every visitor and
  every developer using the key. Tests never call the real API. Don't loop
  real calls while debugging; one request at a time, and say what it costs.
- **Verify upstream behaviour against primary sources**: the live spec at
  `https://api.xbl.io/docs/json` (the docs page is client-rendered), or a
  single real response. Third-party OpenXBL client libraries are out of date
  and have been wrong about what the API can do.
- **Open items** are tracked in [TODO.md](TODO.md) and PLAN §10. Markers in
  code: `TODO(O3)` for the unconfirmed privacy mapping.

## Commands

`npm test` · `npm run typecheck` · `npm run dev` (needs `.dev.vars`, see README)
