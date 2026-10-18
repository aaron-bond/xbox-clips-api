# xbox-clips-api

Backend for a social hub for sharing Xbox game clips. A visitor enters a
gamertag and gets that player's clips, playable and shareable, with no login
for anyone. A Cloudflare Worker fetches clip data from
[OpenXBL](https://xbl.io) with one server-side key, caches it in Workers KV,
and hands media URLs to the browser, which streams video straight from the
Xbox CDN.

Live at `https://xbox-clips-api.xbox-clips-api.workers.dev`.

The design and the reasoning behind it are in [PLAN-v1.md](PLAN-v1.md). The
frontend is [xbox-clips-ui](https://github.com/aaron-bond/xbox-clips-ui).

## API

| Route | Returns |
| :--- | :--- |
| `GET /api/v1/players/:identifier` | Profile. Gamertag or XUID. |
| `GET /api/v1/players/:identifier/clips?limit=` | `{ xuid, access, total, clips }`. `access` is `public` or `restricted`. |
| `GET /api/v1/clips/:xuid/:clipId` | One clip with a playable media URL. |
| `GET /api/v1/clips/:xuid/:clipId/preview` | Clip metadata only, no media URL. Backs the UI's link previews. |
| `GET /api/v1/players/:identifier/career` | `{ xuid, stats }`: facts from the player's last 100 games. Cached 2 hours. |
| `GET /api/v1/players/:identifier/games` | `{ xuid, games, limited }`: the player's recent games, from the same cached read. |
| `GET /api/v1/players/:identifier/achievements/:titleId` | The player's achievements and minutes played in one game. Cached 15 minutes. |
| `GET /api/v1/games/most-played` | `{ games }`: the Xbox Store's most-played games, ranked. Cached 6 hours. |
| `GET /api/v1/games/:productId` | One game from that list. |
| `GET /api/v1/games/:productId/screenshots` | `{ screenshots }`: that game's store screenshots. Cached 7 days. |
| `GET /health` | `{ status: "ok" }` |

Every error has the shape
`{ "error": { "code": "...", "message": "...", "status": 404 } }`. The codes
are listed in PLAN-v1.md §6.

## Local development

Needs Node 24+ and a personal OpenXBL API key from
[xbl.io/dashboard](https://xbl.io/dashboard).

```sh
npm install
cp .dev.vars.example .dev.vars   # then put your key in it
npm run dev                      # http://localhost:8787
```

`.dev.vars` is gitignored. Local KV is simulated by Wrangler, so nothing
touches the production cache.

**The upstream budget is 150 requests per hour on the OpenXBL free tier,
shared by everything using the key.** Repeat requests are served from cache,
but every new player looked up costs 2–3 calls. Don't script loops against the
dev server.

| Command | Does |
| :--- | :--- |
| `npm test` | Runs the suite inside the Workers runtime against local KV. Never calls the real API. |
| `npm run typecheck` | Regenerates runtime types from `wrangler.jsonc`, then runs `tsc`. |
| `npm run dev` | Local Worker on port 8787. |

## Deployment

Pushes to `main` deploy through GitHub Actions after typecheck and tests
pass. Pull requests run typecheck and tests only.

One-time setup:

1. `npx wrangler kv namespace create xbox-clips-api-cache` and put the
   printed id in the existing `kv_namespaces` entry in `wrangler.jsonc`.
   The argument is only the namespace's display name; the binding name
   `CACHE` is what the code uses and stays as it is. Decline Wrangler's
   offer to update the config, which would add a second entry.
2. `npx wrangler secret put XBL_API_KEY` and paste the OpenXBL key, or add
   it in the dashboard under the Worker's Settings → Variables and Secrets
   with type **Secret**. A plain-text variable would be removed by the next
   deploy.
3. In the GitHub repository settings, add the secrets
   `CLOUDFLARE_API_TOKEN` (with Workers edit permission) and
   `CLOUDFLARE_ACCOUNT_ID`.
4. Check `ALLOWED_ORIGINS` in `wrangler.jsonc` against the UI's origins.
   Entries are exact origins, or `https://*.host` for any subdomain of
   `host`.
