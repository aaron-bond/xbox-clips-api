# TODO

Live backlog. Finished items keep a short note on what was actually built and
any trade-off made.

## Before first deploy

- [ ] Create the KV namespace and put its id in `wrangler.toml` (README,
      Deployment step 1).
- [ ] `wrangler secret put XBL_API_KEY`.
- [ ] Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to GitHub secrets.
- [ ] Confirm the UI's Pages origin (`ALLOWED_ORIGINS`, `UI_ORIGIN`) and its
      clip route. The share page redirects to `/clip/:xuid/:clipId`, a
      contract with xbox-clips-ui.

## Open questions

- [ ] **O3: restricted privacy.** Call the clips endpoint for a player with
      restricted capture privacy and record what comes back. The provider
      currently treats `403` and `404` as `restricted`, and an empty `200` as
      public with no clips (`TODO(O3)` in `src/provider/openxbl.ts`).
- [ ] **Early URL death.** One of two measured media URLs died at least 3
      minutes before its `expiration`; the other died at its stamp (PLAN §7,
      O1). The UI must retry the clip route once on a playback error. Widen
      `POLICY.clips.expiryMargin` if early deaths turn out to be common.
- [ ] **Thumbnail as `og:image`.** Thumbnails are served as
      `application/octet-stream`. Paste a deployed share link into Discord
      and a messaging app and check the preview image renders.

## Later

- [ ] Negative-cache unknown gamertags for a short time. Each junk lookup
      currently spends a search call from the shared budget.
- [ ] Pages after the first are not cached, so repeatedly resolving an old
      clip walks the pages each time (bounded at 5). Revisit if share links to
      old clips turn out to be common.
- [ ] Surface `X-RateLimit-Remaining` somewhere visible (it is logged when
      under 20).

## Done

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
