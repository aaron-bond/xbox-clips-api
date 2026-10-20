# TODO

Live backlog. Finished items keep a short note on what was actually built and
any trade-off made.

## Open questions

- [ ] **Career CPU for the heaviest players: risk accepted.** A 1,000-game
      player's first `/career` request of the day measures 13-14 ms of CPU
      against the free plan's 10 ms; no code change reduced it (PLAN §5). Watch
      for `exceededCpu` outcomes; if they appear, move to Workers Paid.

## Later

- [ ] Negative-cache unknown gamertags for a short time. Each junk lookup
      currently spends a search call from the shared budget.
- [ ] Pages after the first are not cached, so repeatedly resolving an old
      clip walks the pages each time (bounded at 5). Revisit if share links to
      old clips turn out to be common.
- [ ] Surface `X-RateLimit-Remaining` somewhere visible (it is logged when
      under 20).

## Done

- [x] **Private clips told apart from failures** (2026-10-20). A player whose
      clips aren't public returns an inner 403 with Xbox's GameMedia error
      10209: reported as restricted ("clips aren't public"), rechecked after 5
      minutes. Other 403/404s stay transient errors. Yesterday's fix had
      turned the private case into an error page.


- [x] **Stray 403/404 on clips no longer cached as "private"** (2026-10-19).
      Upstream intermittently answered a public player's clips with a 403 or
      404; the API stored that as restricted for 15 minutes, so the player
      page said their clips weren't public. Now a transient upstream error:
      not cached, the last good list served, the response logged.


- [x] **O3: restricted privacy answered** (2026-10-18). A player with private
      clips returns an empty `200`, the same as a player with no clips, so
      the API reports public and empty. Confirmed from the cache entry of a
      real player reported to have private clips.


- [x] **Early URL death: closed until someone reports it** (2026-10-18). One
      of two measured media URLs died at least 3 minutes before its
      `expiration` (PLAN §7, O1). The UI retries the clip route once on a
      playback error. If reports come in, widen `POLICY.clips.expiryMargin`.

- [x] **Thumbnail as `og:image` confirmed** (2026-10-18). Despite being served
      as `application/octet-stream`, clip thumbnails render in link
      previews.

- [x] **Uncompressed title history tried and reverted** (2026-10-17). Asking
      upstream for `Accept-Encoding: identity` was honoured but raised career
      CPU from 14 to 21 ms, so Brotli decompression was not the cost.

- [x] **Career history streamed, download cancelled at 100 games**
      (2026-10-17). The 100-game parse alone didn't help heavy players: decoding
      the whole 1 MB body was the cost. The scanner now works incrementally on
      the stream and the Worker cancels the download once it has 100 games.

- [x] **Career facts read only the last 100 games** (2026-10-17). Parsing a
      whole 1,000-game history took 13 ms of CPU in production, over the free
      plan's 10 ms. The Worker now scans the raw text and parses only the
      first 100 entries. The generations fact is dropped (it needs the whole
      history); the biggest haul is the best of the last 100 games.

- [x] **Career facts** (2026-10-17). `GET /api/v1/players/:identifier/career`
      reads the title history once a day per player and caches four derived
      facts (a few hundred bytes, not the 1 MB source). Hidden histories cached
      as null.

- [x] **Richer profiles** (2026-10-17). Profiles now include bio, location,
      tenure (years on Xbox) and reputation, from the same upstream call.
      Cache key bumped to `profile:v2:` so profiles cached in the old shape
      are not served without the new fields. `TenureLevel` is undocumented;
      read as years (PLAN §2).

- [x] **Most-played games** (2026-10-17). `GET /api/v1/games/most-played`
      and `GET /api/v1/games/:productId`, from one cached upstream call
      (fresh 6 hours, kept 7 days). Transformer written against a real
      payload; identical titles merged, ranks renumbered.
      Trade-off: a game page only works while the game is in the current
      list, since the single-game route reads that list rather than
      spending a call on the store's 45 KB-per-product details endpoint.

- [x] **Client IP over the UI's service binding** (2026-10-17). Verified
      live: preview requests from the UI's Pages Function arrive with the
      visitor's IP as `CF-Connecting-IP`, so the per-IP limit needed no
      change.

- [x] **Link previews moved to the UI** (2026-10-16). Removed `/share` and
      its HTML rendering; added `GET /api/v1/clips/:xuid/:clipId/preview`
      returning cached metadata. CORS now allows `https://xboxclips.io`, the
      Pages hostname and `https://*.xbox-clips-ui.pages.dev` previews, via
      a matcher in `src/origins.ts`. `UI_ORIGIN` removed.

- [x] **First deploy** (2026-10-16). Live at
      `https://xbox-clips-api.xbox-clips-api.workers.dev`. KV namespace
      `xbox-clips-api-cache` bound as `CACHE`; `XBL_API_KEY` set as a Worker
      secret with a key used only by production; GitHub secrets set for
      CI deploys. The free plan accepts the rate-limiting binding.
      Trade-off: a non-interactive `wrangler deploy` registered the account's
      `workers.dev` subdomain itself, named after the Worker. It can be
      changed in the dashboard, and applies to every Worker on the account.
- [x] **Config moved to `wrangler.jsonc`** (2026-10-16). Cloudflare
      recommends JSONC for new projects, and some newer Wrangler features
      are only available with a JSON config. Same content as the TOML file.

- [x] **Scaffold per PLAN §8** (2026-10-16). Hono app, KV cache with
      freshness and stale fallback, OpenXBL provider and transformer, share
      page, CI and deploy workflows. 61 tests; smoke-tested against the live
      API once (4 upstream calls).
      Trade-offs:
      - Cache writes are awaited inline rather than via `waitUntil`, for
        simplicity. A failed write is logged and swallowed.
      - The test plugin is `@cloudflare/vitest-plugin`, the renamed
        successor of `@cloudflare/vitest-pool-workers`. It does not isolate
        KV between tests, so the route tests clear the namespace in
        `beforeEach`.
      - `?limit=` falls back to the default (20, max 100) on bad input
        instead of returning 400.
