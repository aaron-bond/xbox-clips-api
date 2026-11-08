# TODO

Live backlog. Finished items keep a short note on what was actually built and
any trade-off made.

## Open questions

- [ ] **CPU on the free plan: risk accepted, needs watching.** A
      1,000-game player's first `/career` request of the day measures 13-14 ms
      of CPU against the free plan's 10 ms; no code change reduced it (PLAN
      §5). A `/games` refresh has measured 20 ms. Watching for `exceededCpu`
      outcomes is part of the observability plan below; if they appear, move
      to Workers Paid.

## Next

- [ ] **Upstream-miss limit** (PLAN §6). A second Rate Limiting binding
      per IP, checked only before an upstream call; plus tighter limits
      on `/career`, `/achievements` and `/nearest-completion`. Tune with
      real refusals.
- [ ] **Observability: alerting, decision deferred** (PLAN §11.2).
      Logging is done: every log line is a named event, filterable in
      Workers Logs (§11.6 steps 2-3). Cloudflare's monitors can't be
      saved on Free (0 allowed). Options: a daily GitHub Actions query
      opening an issue, the Worker alerting on its own events, or
      Workers Paid. To watch: `exceededCpu`, KV writes per day, the
      upstream budget, rate-limit refusals, junk gamertag lookups.

## Later

- [ ] **Lock the API to the site: phase 5, when needed** (PLAN §6,
      "Locking the API to the site"). Deferred 2026-11-08: phases 1-4
      hold for now. Pick it up on signs of abuse: `inbound.rate_limited`
      or `upstream.budget_low` climbing, KV writes nearing the daily
      limit, or a request flood. Then Bot Fight Mode, then a WAF rate
      rule, one at a time; re-test local UI development and clip link
      previews after each. Turnstile only if abuse continues.
- [ ] **Local Seq instance for logs and alerting** (potential feature;
      an alternative to the options in PLAN §11.2). Cloudflare's own log
      export (Logpush, Tail Workers, OpenTelemetry) needs Workers Paid,
      but a poller can pull for free. A container on a home Docker host
      runs a small script every 5-15 minutes. It calls the Workers
      Observability query API with a read-only token, converts each record
      to CLEF and posts it to Seq. Seq's free single-user licence has
      alerts with email. That gives longer history than Workers Logs keeps
      and catches CPU kills (`$workers.outcome`), with no Worker change
      and no upstream cost.
      - First: confirm the query API on Free with one query, using a token
        with only Workers Observability read.
      - Overlap each pull and drop records already sent, so a restart
        neither loses nor repeats any.
      - Page through results if a busy window is larger than one page; the
        API's limits are unchecked.
      - Have Seq alert when the poller goes quiet.
      - Missed pulls are recoverable only within Workers Logs' retention.
      - Check the daily event count against Workers Logs' Free cap.
- [ ] Negative-cache unknown gamertags for a short time. Each junk lookup
      currently spends a search call from the shared budget. Decide once
      observability shows how often it happens. Each entry is a KV write,
      so a script feeding junk names could spend the day's 1,000 writes
      (PLAN §6).
- [ ] A failed Mythics read is not remembered, so the next visit tries the
      slow upstream read again.
- [ ] Pages after the first are not cached, so repeatedly resolving an old
      clip walks the pages each time (bounded at 5). Revisit if share links to
      old clips turn out to be common.
- [ ] Surface `X-RateLimit-Remaining` somewhere visible (it is logged when
      under 20). Likely folded into the observability plan.

## Done

- [x] **API closed to everything but the site** (2026-11-08, PLAN §6
      phases 3-4). `workers_dev` and `preview_urls` off; the Worker is
      reachable only through the UI's service binding. `localhost:5173`
      dropped from `ALLOWED_ORIGINS`. Trade-off: a few old tabs were still
      calling `workers.dev`; they fail until reloaded.

- [x] **Nearest-completion cached 15 minutes per player** (2026-11-06,
      PLAN §5). Key `nearest:{xuid}`, kept no longer than fresh, so no
      stale fallback. Hidden histories are cached too. A loop on one
      player now costs one upstream call per 15 minutes.

- [x] **API served through the site, enforced** (2026-11-05, PLAN §6
      phases 1 and 2). The UI's Pages Function serves `xboxclips.io/api/*`
      over the service binding and refuses cross-site requests with
      `403`. This Worker logs `site guard would refuse` for requests the
      function marks while in `report` mode.
      Trade-off: enforced the same day rather than after a day or two of
      report-only logs; failures, if reported, are handled then.

- [x] **Mythics** (2026-11-01). `mythic` on recent games, and
      `GET /players/:id/mythics`, cached 24 hours (PLAN §5, "Mythics").


- [x] **Workers Logs turned on** (2026-10-23). Unexplained 502s on clips left
      no trace: the code logged the cause, but nothing kept the logs. Now kept
      for a few days in the dashboard.


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
