# API Plan — v1 (first cut)

**Status:** built and deployed. Written 2026-10-16.
**Where this stands right now, and what to do next: §10.**

This is the first-cut plan for `xbox-clips-api`, the backend for a social
hub that lets people share Xbox game clips. It is the authoritative
reference for the v1 design: what is being built, and why each choice was
made. The companion frontend lives in `xbox-clips-ui`.

---

## 1. Product shape

A visitor types a gamertag and gets that player's game clips, playable
and shareable. **No login, for anyone.** Clips are fetched with a single
server-side OpenXBL personal API key; the viewer never authenticates, and
neither does the player whose clips are being viewed.

This is possible because `GET /v2/dvr/gameclips/{xuid}` returns clips for
an arbitrary player, not just for the account that owns the API key.

A caution for anyone extending this: several third-party OpenXBL client
libraries (the Go SDK, the XenForo addon) expose only the key owner's own
clips and have no per-player method at all. They are out of date. Treat
the live OpenAPI document as the only authority on what the API can do.

Visitor state lives on the device — localStorage for recently-viewed
gamertags and favourites. Nothing about a visitor is stored server-side.

---

## 2. Upstream API reference

Verified on 2026-10-16 against the live OpenAPI document, and against live
responses from the API itself. The docs page
at `https://api.xbl.io/docs` is client-rendered and contains no endpoint
list in its HTML; the machine-readable spec is at
`https://api.xbl.io/docs/json` (`curl -sSL https://api.xbl.io/docs/json`).
It identifies as `OpenXBL API 2.0.0`, OpenAPI 3.0.3.

Base URL: **`https://api.xbl.io/v2`**.

### Endpoints used

| Path | Purpose |
| :--- | :--- |
| `GET /v2/search/{gamertag}` | Gamertag → XUID resolution. Fuzzy: returns near matches too. |
| `GET /v2/account/{xuid}` | Profile. Takes an XUID only. Returns `profileUsers[0]` with an `id` and a `settings` array of `{ id, value }` pairs (`Gamertag`, `Gamerscore`, `GameDisplayPicRaw`, `Bio`, `Location`, `TenureLevel`, `XboxOneRep`, …). |
| `GET /v2/dvr/gameclips/{xuid}` | Clips for any player. Paginates via a `continuationToken` query parameter. |
| `GET /v2/marketplace/most-played` | The Xbox Store's most-played games. The same for every caller. Carries box art, poster, hero and square promotional art, but no screenshots. |
| `POST /v2/player/stats` | Player statistics for any players, body `{ xuids, stats: [{ name, titleId }] }`. With `MinutesPlayed` it returns time played in a game, e.g. `{ xuid, titleid, name: "MinutesPlayed", value: "2019" }`; several players can be asked at once. Empty for an Xbox 360 game. |
| `POST /v2/marketplace/details` | Store detail for products named in a JSON body `{ "products": "<id>" }` (comma-separated ids allowed). About 100 KB per product, so one product per call. Its images include the game's screenshots, each listed twice (Desktop and Xbox positions) with a protocol-relative `Uri` and an optional `Caption`. |
| `GET /v2/titles/{xuid}` | A player's title history, newest first: up to 1,000 games with gamerscore progress, unlocked count (`achievement.currentAchievements`), last played and devices (`Xbox360`, `XboxOne`, `XboxSeries`, `PC`). About 1 MB for a heavy player; accepts no filters. |
| `GET /v2/achievements/player/{xuid}/{titleId}` | A player's achievements in a current-generation game: every achievement, unlocked or not, with progress, a 16:9 image, gamerscore, rarity and a secret flag (descriptions are sent even for secret ones). About 60 KB for 49 achievements; no paging seen. |
| `GET /v2/achievements/x360/{xuid}/title/{titleId}` | The same for an Xbox 360 game, but only the achievements the player has unlocked, with a numeric `imageId` and no image URL. Listing locked ones would take a second call (`/v2/achievements/player/{xuid}/title/{titleId}`), not used. |

Two further endpoints exist and are not used in v1:
`GET /v2/dvr/gameclips` (the key owner's own clips) and
`GET /v2/dvr/screenshots/{xuid}`. The screenshots endpoint is not worth
building on: on 2026-10-18 it returned an empty list (`200`, with
`pagingInfo`) for two players, one of them an account known to have
screenshots and whose clips are public. A non-null continuation token
on the first page led only to a second empty page.

**There is no single-clip endpoint and no URL-refresh endpoint.**
Microsoft's underlying gameclips service documents a refresh API, but
OpenXBL does not expose it. The only way to get a fresh media URL for a
clip is to fetch its owner's clip list and match on `gameClipId`. This
shapes share-link resolution in §5.

There is no endpoint that takes a gamertag and returns a profile, so
**profile lookup by gamertag is inherently a two-call sequence**:
resolve to an XUID, then fetch the account. This shapes the caching
design in §5.

### Authentication

A single `X-Authorization: <key>` header on every request. Two kinds of
key exist:

- **Personal keys** — created at `xbl.io/dashboard`, scoped to your own
  account. This is what v1 uses.
- **App keys** — for Xbox SSO, where users sign in with their own Xbox
  accounts. Not used in v1; see §9.

### Rate limiting

Two independent limits apply. The first is the one that binds under
sustained traffic. The second can bite on bursts.

1. **The OpenXBL plan limit: 150 requests per hour on the free tier.**
   It is reported on every response via `X-RateLimit-Limit`,
   `X-RateLimit-Spent` and `X-RateLimit-Remaining`. The headers give the
   count but not the period. Because media URLs last an hour (below), a
   player's clip list cannot be cached for longer than that, so each
   actively viewed player costs about one call an hour. That caps the
   service at roughly 150 distinct players viewed per hour, less search
   and profile calls for gamertags not yet cached.
2. **Microsoft's [fine-grained rate limiting](https://learn.microsoft.com/en-us/gaming/gdk/docs/services/develop/best-practices/live-fine-grained-rate-limiting?view=gdk-2510#implemented-limits)**,
   enforced per user, per Xbox Live service, across two simultaneous
   windows: a 15-second *burst* window and a 300-second *sustain* window.
   Services differ sharply — Profile and Social allow only **10 burst /
   30 sustain**, while Achievements allow 100 / 300. A throttled request
   still counts toward the sustain window. On a 429, Xbox Live returns a
   `Retry-After` header.

Because v1 uses one personal key, **every visitor to the site shares a
single rate-limit budget.** Caching is therefore not a cost optimisation;
it is what makes the service work at all beyond trivial traffic. This
drives most of §5.

### Response envelope

OpenXBL wraps every proxied response as `{ "content": <upstream body>,
"code": <status> }`. The provider unwraps `content` first. Search results
are at `content.people[]`. Each entry carries `xuid` (a 16-digit numeric
string), `gamertag`, `modernGamertag`, `gamerScore` and `displayPicRaw`.

### Profile fields

The API passes on, besides gamertag, gamerscore and gamerpic:

- **`Bio` and `Location`**: player-written; empty for many players, so
  returned as null when empty.
- **`XboxOneRep`**: Xbox's reputation tier. `GoodPlayer`, `NeedsWork` and
  `AvoidMe` are Xbox's Good Player, Needs Work and Avoid Me, the tiers
  Xbox describes publicly (Xbox Wire, 2014 and 2016). Returned as `good`,
  `needs-work`, `avoid`.
- **`TenureLevel`**: undocumented. Read as years of Xbox network
  membership: the Xbox 360 showed tenure as yearly badges, and real values
  fit (Major Nelson's is 22, a test account's 19). Returned as
  `tenureYears`, and labelled in the UI as years on Xbox. If it turns out
  to mean something else, only that label changes.
- `AccountTier` (`Gold`) is not passed on: it names a subscription that no
  longer exists under that name. `PreferredColor` is a link to a colour
  file, not a colour; using it would mean a further fetch, for a design
  idea that was not taken up.

### Clip payload

The spec documents no schema for the clips response; it is described only
as "Game clips list". The shape below is taken from a live response on
2026-10-16. It matches Microsoft's documented
[GameClip](https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/live/rest/json/json-gameclip)
object, with the differences noted.

- `content` is `{ gameClips: [...], pagingInfo: { continuationToken } }`.
  The token is `null` on the last page. A player with 15 clips received
  all 15 on one page; the page size is otherwise unknown.
- Each clip carries, among others, `gameClipId`, `xuid`, `titleName`,
  `titleId`, `userCaption`, `clipName`, `datePublished`, `dateRecorded`,
  `durationInSeconds`, `views`, `thumbnails[]` and `gameClipUris[]`.
- `gameClipUris[]` entries are `{ uri, fileSize, uriType, expiration }`,
  as in Microsoft's
  [GameClipUri](https://devdocs.xbox.com/reference/live/rest/json/json-gameclipuri).
  The sample had one per clip.
- `thumbnails[]` entries are `{ uri, fileSize, thumbnailType }`. The
  sample had two per clip (`thumbnailType` 1 and 2) with the same URI.
- Microsoft's documented `visibility` and `source` fields are absent.
- **Enum fields are integers** (`state`, `type`, `uriType`,
  `thumbnailType`), not the strings Microsoft's documentation shows. The
  transformer maps only the fields it needs and does not depend on enum
  names.

### Clip lifetime

- **A media URL is valid for one hour from the moment it is fetched.**
  Its `expiration` field states the exact time, and a timestamp token in
  the URL (`__gda__`) agrees with it. The hour is set when the URL is
  signed, so every fetch returns a URL with a fresh hour, however old
  the clip is. All URLs in one response share the same `expiration`.
- **Only the signature changes.** A media URL has the form
  `https://gameclipscontent-<host>.media.xboxlive.com/xuid-<xuid>-private/<clipId>.MP4?sv=…&si=DefaultAccess&sr=b&sig=…&__gda__=<unix-expiry>_<hash>`.
  The path is stable. The query string is a signature made with
  Microsoft's key, so a URL cannot be minted locally. The SAS part uses a
  stored access policy (`si=`), so there is no `se=` expiry parameter;
  `expiration` is the field to read.
- **A browser can play it unauthenticated.** A plain `HEAD` on the URL
  returns `200`, `video/mp4`, a `content-length` and a one-year
  `cache-control`, with no auth header.
- **Thumbnail URLs are unsigned and stable** for the life of the clip.
  They sit at `xuid-<xuid>-public/<clipId>_Thumbnail.PNG` with no query
  string, and are served with a 90-day `cache-control`.
- Clips are deleted from the Xbox network about **90 days after
  upload**. No amount of caching changes this, and a share link stops
  working once its clip is deleted. That is accepted: the service never
  stores media (§3). Instead, it reports the expiry honestly (§5, §6).

---

## 3. Implementation decisions

These are the non-obvious choices, recorded with their reasoning so they
are not quietly undone later.

**Provider seam.** All upstream calls go through one interface,
`IXboxDataProvider`, with the OpenXBL implementation behind it and the
mapping from raw payloads to domain types in one place. This keeps
routing and caching logic independent of a third-party schema that is
unofficial, undocumented in places, and has already changed once.

**The API key is passed per request, not captured at construction.** The
provider takes its key as a call-time argument rather than holding one
for its lifetime. v1 always passes the same server-side key, so this
costs nothing now — but it is what allows per-user App Key SSO (§9) to be
added later without restructuring the provider.

**Cache values are JSON-encoded exactly once.** KV stores strings, so
the cache layer calls `JSON.stringify` on write and reads with
`get(key, 'json')`. Nothing else encodes: passing an already-stringified
value would double-encode it, so it would read back as a string and
serialise to a JSON string literal rather than an object.

**Gamertag search only counts an exact match.** The search endpoint is
fuzzy and returns near matches for gamertags that do not exist. The
resolver accepts a result only when its gamertag matches the request
case-insensitively, and otherwise reports `PLAYER_NOT_FOUND`. Taking the
first result would silently show a stranger's clips.

**Clips are cached as the full list and sliced per request.** The `limit`
query parameter must not participate in the cache key, and must not be
applied before storing: caching a limited list means the first caller's
`limit` is frozen in for the whole TTL, so a later `?limit=50` silently
receives only 10 items.

**No locally-maintained rate-limit counter.** Upstream reports real usage
on every response (`X-RateLimit-*`) and signals throttling explicitly
with 429 plus `Retry-After`. A local counter could only approximate that,
would drift, and would be the one workload the chosen cache store is
genuinely bad at (§4). Read the real numbers instead.

**CORS is required, not optional.** The UI is served from a different
origin than the Worker, so without CORS middleware the browser blocks
every call and nothing works at all. Allowed origins are the UI's domain
(`https://xboxclips.io`), its Pages hostname, its preview deployments, and
localhost for development. Preview hostnames change per branch and per
commit, so they are allowed with a subdomain wildcard,
`https://*.xbox-clips-ui.pages.dev`: it matches subdomains of that one
Pages project, over HTTPS, with no port, and nothing else. There is never
a bare wildcard, since this key's budget is worth protecting from other
people's sites.

**Link previews are rendered by the UI, not the API.** A share link is the
UI's own clip page URL, `https://xboxclips.io/clip/:xuid/:clipId`. The UI
adds the per-clip Open Graph tags to that page itself, using metadata from
`GET /api/v1/clips/:xuid/:clipId/preview`. The API serves JSON only and
renders no HTML.

**Both identifiers are validated before use.** `identifier` and `xuid`
are interpolated into cache keys and upstream URLs, so unvalidated input
wastes a shared rate-limit budget on junk lookups and risks exceeding the
512-byte cache-key limit. An all-digit identifier is treated as an XUID;
anything else is validated against the gamertag character set before
being used as a lookup.

**The service is stateless and pass-through, and never holds clip
media.** The UI hands the upstream media URL to the video element, and
the viewer's browser streams it from the Xbox CDN. The Worker serves JSON
metadata and URLs only. It neither proxies video bytes nor copies them
into storage of its own, now or in a later phase. The only server-side
state is the short-lived response cache in KV. This keeps the service
lean and out of the bandwidth path, and leaves Xbox as the sole holder of
players' content. Two limits follow and are accepted:
- a clip's URL expires an hour after it is fetched, so it must be
  re-resolved upstream;
- a share link stops working when Xbox deletes the clip, about 90 days
  after upload.

**Share links are resolved from stable identifiers, not stored URLs.**
A clip's `xuid` and `gameClipId` never change, so a share link carries
exactly those two and nothing else. Media URLs, which expire hourly, are
re-resolved upstream on demand. The link itself is the long-lived
reference, and no server-side record of shares is kept.

**A cached media URL is never served past its own `expiration`.** A
clips entry counts as fresh only until shortly before the earliest URL
in it expires. Any entry served stale, under upstream pressure (§5), has
its expired URLs removed first. Metadata may be served stale; a dead
media link never is.

**Upstream error text is never forwarded to clients.** It is logged and
replaced with a fixed message per error code, so internal details and
upstream quirks do not leak into the public API (§6).

---

## 4. Stack

**Cloudflare end to end.** A Worker with Workers KV and the native Rate
Limiting binding for the API; Cloudflare Pages for the UI. One vendor,
one deploy story, no extra secrets, and no additional network hop from
the edge to a third-party datastore.

| Layer | Choice | Rationale |
| :--- | :--- | :--- |
| Runtime | Cloudflare Workers | No cold starts, generous free tier, fixed-price cap above it, runs at the edge. |
| Routing | Hono | Small, Web-Standards-native router built for Workers. See below. |
| Language | TypeScript, strict | The upstream payloads are untyped and partly undocumented; the domain types are the guardrail. |
| Cache | Workers KV | Native binding, no second vendor. Sized below. |
| Inbound limits | Cloudflare Rate Limiting binding | Per-IP, and costs no KV writes. |
| UI hosting | Cloudflare Pages | Needed for share-link previews. See below. |

**Why Hono.** It is a routing framework — the layer that turns an
incoming `Request` into "which handler should run, with which path
parameters", plus middleware for cross-cutting concerns like CORS and
error handling. A Worker's raw entry point is a single
`fetch(request, env)` function, so without a router every route becomes
hand-rolled URL parsing and branching. Hono is built on the same Web
Standards primitives Workers use (`Request`/`Response`, no Node APIs), is
a few kilobytes, and has no dependencies — which matters when the whole
bundle ships to the edge on every deploy. It is roughly "Express, for
edge runtimes", and is the conventional choice for this kind of Worker.
The alternative of no framework at all was considered and rejected:
viable for five routes, but CORS, consistent error envelopes and typed
path params are exactly the boilerplate it removes, and §6 depends on
that envelope being uniform.

**Workers KV, against its documented limits:**

- **No cap on the number of keys** — unlimited per namespace, on both
  plans.
- Storage 1 GB on the free plan (unreachable for JSON metadata); key
  512 bytes; value 25 MiB; minimum `cacheTtl` 30s.
- Reads 100,000/day free. **Writes 1,000/day on the free plan** — the
  real constraint, since every cache miss is a write. The clips TTL is
  under an hour (§5), so a player viewed around the clock costs up to 24
  clips writes a day. A player viewed now and then costs one write per
  visit. The OpenXBL budget allows up to 3,600 upstream calls a day,
  each followed by a write. So at full upstream utilisation the KV free
  plan binds first. Writes are unlimited on the $5/mo Workers Paid plan,
  which is the planned answer if that happens.
- Eventually consistent: a write may take ~60s to become visible in other
  locations. Harmless at hour-scale TTLs, and the reason a rate-limit
  counter must not live here.
- Cloudflare documents KV as being for "read-heavy, highly cacheable
  workloads" and names API response caching explicitly, so this is its
  intended use rather than a workaround.

If the write quota ever binds, the escape valve is layering
`caches.default` — the edge Cache API, free and without a write quota,
but per-datacenter rather than global — in front of KV. Not built in v1.

**Why Pages for the UI.** Share links need Open Graph meta tags. A static
single-page app cannot emit per-clip `og:*` tags, so a link pasted into
Discord or WhatsApp unfurls as a bare URL — which undercuts the entire
point of a sharing hub. A Pages Function on the UI's clip route adds the
real tags, and Pages keeps the UI on the same platform as the Worker. The
repository itself stays on GitHub; only the hosting differs.

---

## 5. API surface and caching

Base path `/api/v1`.

| Route | Purpose |
| :--- | :--- |
| `GET /api/v1/players/:identifier` | Profile. Accepts a gamertag or an XUID. |
| `GET /api/v1/players/:identifier/clips?limit=` | That player's clips. |
| `GET /api/v1/clips/:xuid/:clipId` | One clip, with a media URL valid for playback. Powers the UI's clip page. |
| `GET /api/v1/clips/:xuid/:clipId/preview` | Clip metadata only, never a media URL. Backs the UI's link previews. Served from cached metadata. |
| `GET /api/v1/players/:identifier/career` | `{ xuid, stats }`: facts from the player's last 100 games (now playing, biggest haul, nearest to 100%). `stats` is null when the history is hidden. |
| `GET /api/v1/players/:identifier/games` | `{ xuid, games, limited }`: the player's recent games (at most 100, newest first) with gamerscore progress, unlocked count and an `xbox360` flag. From the same cached read as `/career`, so it costs no extra upstream call. Empty when the history is hidden. |
| `GET /api/v1/players/:identifier/achievements/:titleId` | `{ xuid, titleId, game, titleName, lockedListed, minutesPlayed, achievements }`: the player's achievements in one game, and minutes played (null when Xbox reports none). Xbox 360 games (known from the recent games) use the 360 endpoint and set `lockedListed: false`. Hidden achievements of a recent game come back as an empty list; a title with none that isn't among the recent games is `404 NOT_FOUND`. A malformed title ID is `400 INVALID_IDENTIFIER`. |
| `GET /api/v1/games/most-played` | `{ games }`: the store's most-played games, ranked, duplicates merged. |
| `GET /api/v1/games/:productId` | One game from that cached list, for the UI's game page. `404 GAME_NOT_FOUND` if it is not in the list. |
| `GET /api/v1/games/:productId/screenshots` | `{ screenshots }`: the game's store screenshots (`url`, `caption` or null, `width`, `height`), in store order, at most 30. Only for games in the most-played list: any other id is `404 GAME_NOT_FOUND` before any upstream call, so arbitrary ids can't spend the budget. |
| `GET /health` | Liveness. |

### Cache key schema

| Key | Value | TTL | Rationale |
| :--- | :--- | :--- | :--- |
| `xuid:{gamertag_lower}` | XUID string | 30 days | The mapping is immutable, and Profile/Social is the strictest-limited upstream service. Cache it hard. |
| `profile:v2:{xuid}` | `XboxUserProfile` | Fresh 2 hours, kept 48 hours | Short enough that gamerscore keeps up with achievements (fresh 15 minutes). Microsoft throttles profile calls more than any other (repeated 429s seen in production); the long retention lets a throttled refresh serve the stale copy. With no copy at all the profile route fails, but the clips route does not depend on it: it needs only the XUID mapping, so a client can still show the player's clips. |
| `clips:{xuid}` | **full** `GameClipInfo[]`, with media URLs | Fresh 15 minutes, or until the earliest `expiration` in the list minus 5 minutes if that is sooner. Kept in KV for 6 hours. | A new clip shows within 15 minutes of reaching Xbox. Whole list stored, sliced per request. The extra retention exists only for stale serving, with expired URLs removed (§3). |
| `career:v3:{xuid}` | `{ history }`: the career facts and the recent games | Fresh 2 hours, kept 7 days | A game just played reaches the recent games and career facts within 2 hours; each refresh is the title-history read below, which carries the accepted CPU risk (§5). One read of the title history (stopped at 100 games, §5) serves `/career`, `/games` and the Xbox 360 lookup for achievements. Only the derived facts and a trimmed games list are stored, about 20 KB, not the up to 1 MB source. A hidden history is cached as null too. v2 held the facts only. |
| `achievements:{xuid}:{titleId}` | `{ titleName, achievements }` | Fresh 15 minutes, kept 7 days | A new unlock shows within 15 minutes. About 20 KB for 49 achievements. Hidden achievements are cached as null. |
| `playtime:{xuid}:{titleId}` | `{ minutes }` | Fresh 15 minutes, kept 7 days | Minutes played, from `POST /v2/player/stats`. Null when Xbox reports none (Xbox 360 games). A failure to fetch it never fails the achievements response. |
| `games:most-played` | `Game[]` | Fresh 6 hours, kept 7 days | The same for every visitor, so one upstream call per window serves all traffic: at most 4 a day. |
| `screenshots:{productId}` | `Screenshot[]` | Fresh 7 days, kept 30 days | Store images barely change. Only the parsed list is stored (about 5 KB for 23 screenshots), not the 100 KB detail payload. With at most 25 ranked games this is under 4 KV writes a day. |
| `clip:{xuid}:{clipId}` | Clip metadata **without** media URL | Valid until `datePublished` + 90 days. Kept in KV 30 days beyond that. | Title, game, caption, duration, thumbnail and dates never change, so share previews need no upstream call. The extra 30 days let an expired link answer `410` rather than `404`. |

The `clips:` freshness window is 15 minutes, cut short by the payload
when needed: the `expiration` stamps say exactly how long the URLs are
good for, and the 5-minute margin leaves time for playback to start before
the URL dies.

**Freshness, reviewed 2026-10-18.** Windows were shortened so a player's
own activity shows quickly and the pages agree with each other: clips and
achievements 15 minutes, profile and title history 2 hours (from 55
minutes, 1 hour, 12 hours and 24 hours). A stale entry is refetched while
the visitor waits; stale-while-revalidate was considered and not adopted.
Upstream calls happen only when someone views a player after a window
lapses: about 9 an hour for a player watched continuously, from about 3.
Each refresh is also a KV write, so the free plan's 1,000 writes a day
allows roughly 100 player-hours of active viewing. The 6-hour KV retention costs no extra writes, because the
entry is rewritten on every refetch anyway.

`clip:` entries are written lazily, on the first clip or preview
request for that clip, not for every clip in a fetched list. That keeps
each list fetch to a single KV write.

### Resolving a clip for playback

`GET /api/v1/clips/:xuid/:clipId`, which the UI's clip page calls, works
like this:

1. If `clips:{xuid}` is cached, still fresh, and holds the clip, return
   it. Its URL is valid by construction of the freshness window.
2. Otherwise fetch the player's clip list (one upstream call), store it
   as `clips:{xuid}`, and look for `gameClipId`. The fetch re-signs every
   clip on that page, so other clips from the same player become free.
3. If the clip is not on the first page, follow `continuationToken`, one
   upstream call per page, until it is found or the list ends, up to 5
   pages in all. Later pages are not cached: only the first page backs a
   player's shelf.
4. If it is not found: return `CLIP_EXPIRED` when its `clip:` metadata
   shows it is past `datePublished` + 90 days, otherwise
   `CLIP_NOT_FOUND` (§6).

If the video element reports a playback error, the UI calls this route
once more before giving up, which covers a URL that died early.

Every clip response carries `availableUntil` (`datePublished` + 90
days), so the UI can say how long a clip will stay up. Xbox does not
publish the exact deletion time, so this is an estimate and is labelled
as one in the UI.

### Career facts

`GET /v2/titles/{xuid}` returns a player's title history, **newest first**:
up to 1,000 games, about 1 MB for a heavy player. It accepts no filters:
the spec lists none, an undocumented `maxItems` was tried and ignored, and
the legacy `/v2/player/titleHistory/{xuid}` returns the same data.

**Only the most recent 100 games are read, and the download stops there.**
The Worker reads the response as it streams in, scanning each piece for the
end of each entry (tracking strings and escapes, so braces inside names
don't count). At the end of the 100th entry it cancels the download and
parses only that slice. If the body ends first, it was a short history or an
error envelope; the whole text is then in hand, and OpenXBL's inner status
code is read from its tail as for any other response. The facts:

- **Now playing:** the most recently played game.
- **Biggest haul:** the game with the most gamerscore earned, among those 100.
- **On the brink:** the game nearest to 100% that is not complete and has
  some gamerscore earned; ties go to the bigger game.

Apps are left out. When the player has more than 100 games the result is
flagged `limited`, and the UI says "from their last 100 games". A 403 or 404
means the history is hidden, and is returned and cached as null rather than
as an error.

**Why, measured in production on 2026-10-17:** parsing the whole history of
a 1,000-game player took **13 ms** of CPU, over the free plan's 10 ms per
request; a 731-game player took 9 ms. Parsing only the first 100 entries of
a fully downloaded body brought the 731-game player to 6 ms but left the
1,000-game player at 13 ms: for a heavy history, **decoding the whole 1 MB
body into a string** was the main cost, not parsing it. The Worker
therefore streams the body and stops at 100 games. That did not bring the
1,000-game player down either (14 ms). Upstream sends the history
Brotli-compressed (about 156 KB on the wire); asking for it uncompressed was
honoured, but raised CPU to 21 ms, so decompression was not the cost. The
measurements fit CPU tracking the bytes the runtime takes in, which the
Worker cannot reduce: upstream accepts no filters, and the runtime appears to
receive the whole response however early the Worker stops reading. So the
compressed, streamed version is kept: it is correct, keeps cached facts small,
and helps mid-sized histories (the 731-game player went from 9 to 6 ms).

**Accepted risk:** for the heaviest players (roughly 1,000 games), the first
career request of the day can exceed the free plan's 10 ms CPU. Cloudflare
let every measured request complete, but may not always. If it does cut one
off, the career section is missing for that visit, nothing is cached, and
the next visit fetches again. Moving to Workers Paid (30 s CPU) removes this
risk, and would also lift the free plan's KV write cap. Upstream builds the
whole response before sending it, so a heavy player's first request of the
day can take several seconds; waiting does not count as CPU.

**What was given up:** a per-platform "generations" fact, which needs the
whole history and cannot be derived from recent games; and career-best
framing, so the biggest haul is the best of the last 100 games, not of all
time.

Other sources were sampled and rejected: per-achievement records (unordered,
tens of thousands for a heavy player, no rarity) and player stats (no
playtime value).

### Most-played games

`GET /v2/marketplace/most-played` returns a ranked first page of 25 store
products, out of roughly 18,000. The transformer keeps channel order and
merges products with identical titles, keeping the best rank, because
editions and platform versions are listed separately (one response listed
Grand Theft Auto VI three times). The Xbox title ID cannot do the merging:
most products lack one, and unrelated games that share a launcher share
one. Ranks are renumbered after merging. The description is the store's
short description, or the opening of the full one when the short one is
only a tagline. Image URLs are passed through unchanged; they resize by
query string (`?w=640`) and the originals reach 3840 px, so clients always
ask for a size. Prices are omitted (they arrive in one currency whatever
the visitor's country), as are Game Pass details (passes are listed only
by internal IDs).

There is no endpoint for clips by game across players, so the UI's game
page shows store information, not clips.

### Link previews

`GET /api/v1/clips/:xuid/:clipId/preview` returns only the clip's title,
game, caption, thumbnail and dates, all of which are stable. It reads
`clip:{xuid}:{clipId}` first and only calls upstream on a cache miss. A
link pasted into a chat app is therefore unfurled without spending the
shared budget, except the first time that clip is previewed. It never
returns a media URL or a view count.

### Serving stale under pressure

Each cached entry carries a `cachedAt` timestamp and a *soft* freshness
window shorter than its KV TTL. On an upstream 429 or 5xx, a stale-but-
present entry is served instead of failing the request. With one shared
rate-limit budget across all visitors, degrading to slightly-stale data
is strictly better than erroring, and it costs nothing — the data is
already in KV.

For clips this applies to metadata only. A stale list can still be
served so the player's shelf renders, but any media URL past its
`expiration` is removed and the clip is marked as not currently
playable. A dead link is never served as a live one.

---

## 6. Error model

One response shape for every failure:

```json
{ "error": { "code": "UPSTREAM_RATE_LIMIT", "message": "...", "status": 429 } }
```

| Condition | Status | Code |
| :--- | :--- | :--- |
| Malformed gamertag, XUID or clip id | 400 | `INVALID_IDENTIFIER` |
| Unknown route | 404 | `NOT_FOUND` |
| Gamertag resolves to nothing | 404 | `PLAYER_NOT_FOUND` |
| Clip not in the player's list | 404 | `CLIP_NOT_FOUND` |
| Clip past its 90-day deletion | 410 | `CLIP_EXPIRED` |
| Game not in the most-played list | 404 | `GAME_NOT_FOUND` |
| Player's DVR privacy hides their clips | 200 | *not an error* — see below |
| Inbound per-IP limit exceeded | 429 | `RATE_LIMITED`, with `Retry-After` |
| Upstream 429 | 429 | `UPSTREAM_RATE_LIMIT`, with `Retry-After` passed through |
| Upstream 5xx or unreachable | 502 | `UPSTREAM_ERROR` |
| Anything else | 500 | `INTERNAL_ERROR` |

**DVR privacy is a first-class state, not an error.** A player can
restrict who sees their captures, so a perfectly valid XUID may return an
empty list. **Upstream does say which** (O3, settled 2026-10-20). A
player with nothing to show returns an ordinary empty `200`. A player whose
clips aren't public returns Xbox's own error inside OpenXBL's envelope:
HTTP `200`, inner `code: 403`, and `content: { errorMessage: "GameMedia
Error Code", HttpStatusCode: 403, errorCode: 10209 }`. The API reports that
as `access: "restricted"`, rechecked after 5 minutes rather than 15 in case
upstream sends it in error. Any other `403` or `404` from the clips
endpoint is a transient failure: upstream returned one for a player with
public clips on 2026-10-19 and a full `200` two minutes later. It is an
`UPSTREAM_ERROR`, never cached; the last good list is served if there is
one, and the status and body are logged. A non-owner key does receive a
public player's clips.

**Deleted clips get their own code.** `410 CLIP_EXPIRED` tells the UI
the clip existed and has aged out on Xbox, so a share link can say that
plainly instead of showing a broken player or a generic 404.

### Inbound rate limiting

Cloudflare's native Rate Limiting binding, per IP, protects the shared
upstream budget from a single abusive client. Deliberately not
KV-based: per-request counters would burn the daily write quota (§4).

---

## 7. Findings and open questions

Answered against the live API on 2026-10-16. Each can be re-checked
with `curl` and a personal key; every OpenXBL call spends one request of
the hourly budget, and probing a media URL spends none:

```
curl -s -H "X-Authorization: $XBL-API-KEY" https://api.xbl.io/v2/search/<gamertag>
curl -s -H "X-Authorization: $XBL-API-KEY" https://api.xbl.io/v2/dvr/gameclips/<xuid>
curl -sI '<media url>'
```

- **O1 — Media URL lifetime: one hour from fetch.** Each URL carries an
  `expiration` exactly 60 minutes after the response, and the URL's
  `__gda__` token encodes the same second. The clip was published days
  earlier, so the hour runs from signing, not from upload. Consequences:
  the `clips:` TTL is derived from the `expiration` stamps (§5), and
  media URLs are never cached past them (§3).
  **Enforcement was measured on two URLs for the same clip.**
  - **Signed 12:32:59 UTC, stamped 13:32:58.** It worked at 13:32:50 and
    returned `403` at 13:33:50, so it died at its stamp.
  - **Signed 11:58:00, stamped 12:57:59.** It was already returning
    `403` at 12:55:00, at least 3 minutes early. The cause is unknown.
    Re-signing does not revoke older URLs: the first URL kept working
    after the same clip was re-signed at 12:41.
  The stamp is therefore the normal lifetime, but not a guarantee. The
  5-minute freshness margin covers the normal case. A URL that dies early
  is covered by the UI retrying the clip route once on a playback error
  (§5), which is a required part of the design, not an optimisation.
- **O2 — Clip field names: answered.** See "Clip payload" in §2. The
  shape is Microsoft's GameClip object with integer enums, inside the
  OpenXBL `{ content, code }` envelope. The transformer can be written.
- **O3 — Privacy-restricted players: answered** (2026-10-20). A key that
  does not belong to the player receives their public clips. A player
  whose clips aren't public returns an inner `403` carrying Xbox's
  GameMedia error `10209` (§3); one with nothing to show returns an empty
  `200`. A first reading (2026-10-18) took an empty `200` for privacy,
  from a player reported to have private clips; the 10209 response,
  seen directly on 2026-10-20, is the definitive sign.

---

## 8. Repo scaffold

- TypeScript, strict mode.
- Hono for routing (§4).
- `wrangler.jsonc` carrying the KV namespace binding and the rate-limit
  binding. JSONC rather than TOML because Cloudflare recommends it for new
  projects and makes some newer features available only with a JSON
  config. `XBL_API_KEY` is a secret via `wrangler secret put`, never a
  `[vars]` entry — `[vars]` values are committed in plain text.
- Vitest with `@cloudflare/vitest-plugin` (the renamed successor of
  `@cloudflare/vitest-pool-workers`), so tests exercise real Worker
  semantics against Miniflare-backed KV rather than mocks. KV is not
  isolated between tests, so route tests clear it before each one.
- Runtime types generated from `wrangler.jsonc` by `wrangler types` before
  every typecheck, not committed.
- A fake `IXboxDataProvider` for tests, so the suite never touches the
  network or spends rate-limit budget.
- GitHub Actions: typecheck and test on pull requests, deploy to
  Cloudflare on `main`.
- `README.md` for setup and local development. `CLAUDE.md` holding the
  architecture and the reasoning behind it, as the fast way back into
  context without re-deriving the design. `TODO.md` as the live backlog,
  where finished items keep a short note on what was actually built and
  any trade-off made, since the note is more useful later than the tick.

Restricted privacy (O3) is answered: an inner `403` with Xbox's GameMedia
error `10209` is `restricted`; any other `403` or `404` from the clips
endpoint is a transient upstream error (§3).

---

## 9. Deliberately out of scope for v1

- **Xbox SSO via App Keys.** Would let a player see their own private
  clips, and would move rate-limit budget onto per-user keys instead of
  one shared key. The provider takes its key per request (§3)
  specifically so this needs no restructuring.
- **Screenshots.** The upstream endpoint exists and mirrors clips. The
  provider interface should leave room for it; v1 does not expose it.
- **Any database.** No feed, reactions, comments or accounts. All of
  those need persistent server-side state and would end the stateless
  design.

---

## 10. Current status

Updated 2026-10-16.

**Built per §8 and deployed** to
`https://xbox-clips-api.xbox-clips-api.workers.dev`. Pushes to `main`
deploy through GitHub Actions. Every route in §5 is implemented, with the
caching, stale-serving and error rules above. The suite has 61 tests and never touches the network.
One local smoke run against the live API exercised every route and cost
4 upstream calls. Repeat requests were served from cache. `TODO.md` is the
working backlog; `CLAUDE.md` is the map of the code.

### Settled

- The product shape in §1: no login, one server-side personal key, device-
  local visitor state. Confirmed against the live API — a non-owner key
  receives another player's clips.
- The whole of §2, verified against the live OpenAPI document and live
  responses.
- Cloudflare end to end (§4): Worker, Workers KV, the native Rate
  Limiting binding, and Pages for the UI. No Upstash — it was considered
  and rejected once the local rate-limit counter was dropped, since
  atomic increments were its only real advantage here.
- Pages rather than static hosting for the UI, so share links can carry
  real Open Graph tags. The UI renders them; the API serves metadata
  through the preview endpoint (§3, §5).
- Hono for routing (§4), rather than a hand-rolled matcher: path params,
  CORS and a single consistent error envelope are exactly the boilerplate
  it removes, and §6 depends on that envelope being uniform.
- The service is stateless and pass-through (§3). Clip media plays in
  the browser straight from the upstream URL. The Worker never proxies
  or stores video bytes, in v1 or later.
- Media URLs last one hour from fetch (O1). Cache freshness follows the
  payload's `expiration` stamps (§5).
- Share links resolve through `xuid` + `gameClipId`. Previews render from
  cached metadata. Clips past 90 days return `410 CLIP_EXPIRED` (§5, §6).
- The per-IP limit works for the UI's preview function: over the service
  binding, the API receives the visitor's own IP as `CF-Connecting-IP`
  (verified 2026-10-17). Cloudflare sets that header on internet requests,
  so clients cannot spoof it.

### Open

None.

### Closed

- **Restricted-privacy response (O3). Answered** (2026-10-20): an inner
  `403` with GameMedia error `10209` (§3, §10).
- **Early URL death (O1). Closed until someone reports it** (2026-10-18).
  One of two measured URLs stopped working at least 3 minutes before its
  `expiration`, cause unknown. The UI's retry-on-playback-error covers it.
  If reports come in, widen the freshness margin in
  `POLICY.clips.expiryMargin`.
- **Thumbnail content type. Confirmed** (2026-10-18). Thumbnails are
  served as `application/octet-stream`, and still render as `og:image` in
  link previews.

### Next steps, in order

1. Comparing two players' achievements in a game needs no new route: the
   UI asks `/achievements/:titleId` for each player. Each player's list is
   one upstream call per hour while viewed.
