import { describe, expect, it } from 'vitest';
import { pickDescription, pickSearchMatch, firstTitles, TitlesScanner, toCareerStats, toClip, toClipPage, toMostPlayed, toProfile, toScreenshots, type RawMostPlayed, type RawStoreDetails, type RawTitle } from '../src/provider/openxbl-transform';
import { titlesResponse } from './fixtures/titles';
import { storeDetailsResponse } from './fixtures/store-details';
import { mostPlayedResponse } from './fixtures/most-played';
import { accountResponse, CLIP_ID, clipsResponse, EXPIRATION, rawClip, searchResponse, XUID } from './fixtures/openxbl';

describe('pickSearchMatch', () => {
  it('returns the XUID of the exact gamertag match, case-insensitively', () => {
    expect(pickSearchMatch(searchResponse.content, 'testplayer')).toBe(XUID);
    expect(pickSearchMatch(searchResponse.content, 'TESTPLAYER2')).toBe('2533274900000002');
  });

  it('returns null rather than a near match, since search is fuzzy', () => {
    expect(pickSearchMatch(searchResponse.content, 'TestPlaye')).toBeNull();
    expect(pickSearchMatch({ people: [] }, 'TestPlayer')).toBeNull();
    expect(pickSearchMatch({}, 'TestPlayer')).toBeNull();
  });
});

describe('toProfile', () => {
  it('maps the settings array', () => {
    expect(toProfile(accountResponse.content)).toEqual({
      xuid: XUID,
      gamertag: 'TestPlayer',
      gamerscore: 12345,
      gamerpicUrl: 'https://images-eds-ssl.xboxlive.com/image?url=example&format=png',
      bio: 'Clips from the couch.',
      location: null,
      tenureYears: 19,
      reputation: 'good',
    });
  });

  it('maps every reputation tier and tolerates missing extras', () => {
    const user = (settings: { id: string; value: string }[]) => ({ profileUsers: [{ id: '1', settings: [{ id: 'Gamertag', value: 'A' }, ...settings] }] });
    expect(toProfile(user([{ id: 'XboxOneRep', value: 'NeedsWork' }]))?.reputation).toBe('needs-work');
    expect(toProfile(user([{ id: 'XboxOneRep', value: 'AvoidMe' }]))?.reputation).toBe('avoid');
    expect(toProfile(user([{ id: 'XboxOneRep', value: 'Unknown' }]))?.reputation).toBeNull();
    expect(toProfile(user([]))).toMatchObject({ bio: null, location: null, tenureYears: null, reputation: null });
    expect(toProfile(user([{ id: 'TenureLevel', value: 'x' }]))?.tenureYears).toBeNull();
  });

  it('returns null when there is no user', () => {
    expect(toProfile({ profileUsers: [] })).toBeNull();
    expect(toProfile({})).toBeNull();
  });
});

describe('toClip', () => {
  it('maps a live-shaped clip', () => {
    expect(toClip(rawClip)).toEqual({
      clipId: CLIP_ID,
      xuid: XUID,
      gameTitle: 'Example Game',
      titleId: 1234567890,
      caption: '',
      durationSeconds: 29,
      recordedAt: '2026-10-01T18:19:00Z',
      publishedAt: '2026-10-01T18:20:30.1234567Z',
      thumbnailUrl: rawClip.thumbnails[1]!.uri,
      availableUntil: '2026-12-30T18:20:30.123Z',
      views: 2,
      media: { url: rawClip.gameClipUris[0]!.uri, expiresAt: EXPIRATION },
    });
  });

  it('prefers the MP4 entry regardless of uriType', () => {
    const clip = toClip({
      ...rawClip,
      gameClipUris: [
        { uri: 'https://cdn.test/manifest.ism/manifest?sig=x', uriType: 2, expiration: EXPIRATION },
        { uri: 'https://cdn.test/clip.MP4?sig=y', uriType: 9, expiration: EXPIRATION },
      ],
    });
    expect(clip?.media?.url).toBe('https://cdn.test/clip.MP4?sig=y');
  });

  it('uses the caption, then the clip name', () => {
    expect(toClip({ ...rawClip, userCaption: 'Nice', clipName: 'Name' })?.caption).toBe('Nice');
    expect(toClip({ ...rawClip, userCaption: '', clipName: 'Name' })?.caption).toBe('Name');
  });

  it('has no media when the URI or its expiration is missing', () => {
    expect(toClip({ ...rawClip, gameClipUris: [] })?.media).toBeNull();
    expect(toClip({ ...rawClip, gameClipUris: [{ uri: 'https://cdn.test/a.mp4' }] })?.media).toBeNull();
  });

  it('drops clips without an id, owner or date', () => {
    expect(toClip({ ...rawClip, gameClipId: undefined })).toBeNull();
    expect(toClip({ ...rawClip, xuid: undefined })).toBeNull();
    expect(toClip({ ...rawClip, datePublished: undefined, dateRecorded: undefined })).toBeNull();
  });
});

describe('toClipPage', () => {
  it('maps the list and a null continuation token', () => {
    const page = toClipPage(clipsResponse.content);
    expect(page.clips).toHaveLength(1);
    expect(page.continuationToken).toBeNull();
    expect(page.access).toBe('public');
  });

  it('carries a continuation token', () => {
    expect(toClipPage({ gameClips: [], pagingInfo: { continuationToken: 'abc' } }).continuationToken).toBe('abc');
  });
});

describe('toMostPlayed (real payload, trimmed)', () => {
  const games = toMostPlayed(mostPlayedResponse.content as unknown as RawMostPlayed);

  it('keeps channel order and merges identical titles, re-ranking without gaps', () => {
    expect(games.map((g) => [g.rank, g.title])).toEqual([
      [1, 'Gears of War: E-Day'],
      [2, 'Fortnite'],
      [3, 'Grand Theft Auto VI: Ultimate Edition'],
      [4, 'Grand Theft Auto VI'],
    ]);
  });

  it('maps the fields the UI needs', () => {
    expect(games[0]).toMatchObject({
      productId: '9N4PT8HGCDHQ',
      genres: ['Shooter', 'Action & adventure'],
      developer: 'The Coalition',
      publisher: 'Xbox Game Studios',
      rating: 4.3,
      ratingCount: 58,
      platforms: ['XboxSeriesX', 'PC', 'XCloud', 'Handheld'],
    });
    expect(games[0]!.heroImageUrl).toMatch(/^https:\/\/store-images\.s-microsoft\.com\//);
    expect(games[0]!.boxArtUrl).toMatch(/^https:\/\/store-images\.s-microsoft\.com\//);
  });

  it('falls back to the full description when the short one is only a tagline', () => {
    expect(games[0]!.description).toBe(mostPlayedResponse.content.productSummaries[0].shortDescription.trim());
    expect(games[2]!.description.length).toBeGreaterThan(80);
  });

  it('copes with an empty or missing payload', () => {
    expect(toMostPlayed({})).toEqual([]);
  });
});

describe('pickDescription', () => {
  it('uses a real short description as is', () => {
    expect(pickDescription('x'.repeat(100), 'full')).toBe('x'.repeat(100));
  });

  it('cuts a long full description at a sentence end', () => {
    const full = 'First sentence here. '.repeat(40);
    const out = pickDescription('Tagline', full);
    expect(out.endsWith('.')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(600);
  });
});

describe('firstTitles', () => {
  const envelope = (titles: unknown[]) => JSON.stringify({ content: { xuid: '1', titles, achievementSummary: { a: 1 } }, code: 200 });

  it('parses only the first N entries and says whether more follow', () => {
    const raw = envelope([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
    expect(firstTitles(raw, 2)).toEqual({ titles: [{ name: 'A' }, { name: 'B' }], more: true });
    expect(firstTitles(raw, 3)).toEqual({ titles: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], more: false });
    expect(firstTitles(raw, 10).titles).toHaveLength(3);
  });

  it('is not fooled by braces, brackets or escaped quotes inside strings', () => {
    const tricky = [{ name: 'Brace } here {', d: { n: [1, { x: ']' }] } }, { name: 'Quote \\" and \\\\ end' }, { name: 'Z' }];
    expect(firstTitles(envelope(tricky), 2).titles).toEqual(tricky.slice(0, 2));
  });

  it('gives the same result fed in pieces as whole', () => {
    const titles = Array.from({ length: 30 }, (_, i) => ({ name: `G${i} "quoted" {braced}`, n: [i, { x: ']' }] }));
    const raw = envelope(titles);
    for (const size of [1, 7, 64]) {
      const scanner = new TitlesScanner(20);
      for (let i = 0; i < raw.length && !scanner.done; i += size) scanner.push(raw.slice(i, i + size));
      if (!scanner.done) scanner.finish();
      expect(scanner.result()).toEqual({ titles: titles.slice(0, 20), more: true });
    }
  });

  it('copes with an empty or missing titles array', () => {
    expect(firstTitles(envelope([]), 100)).toEqual({ titles: [], more: false });
    expect(firstTitles('{"content":{},"code":200}', 100)).toEqual({ titles: [], more: false });
  });
});

describe('toCareerStats (real payload, trimmed)', () => {
  const stats = toCareerStats(titlesResponse.content.titles as unknown as RawTitle[], false);

  it('picks the most recently played game', () => {
    expect(stats.nowPlaying).toMatchObject({ name: "Assassin's Creed Black Flag Resynced", gamerscore: 330, totalGamerscore: 1000, percent: 33 });
    expect(stats.nowPlaying!.imageUrl).toMatch(/^https:\/\/store-images\.s-microsoft\.com\//);
  });

  it('picks the biggest gamerscore haul', () => {
    expect(stats.biggestHaul).toMatchObject({ name: 'Titanfall', gamerscore: 1260, totalGamerscore: 2000 });
  });

  it('picks the game nearest to 100%, ignoring completed ones', () => {
    expect(stats.onTheBrink).toMatchObject({ name: "Hellblade: Senua's Sacrifice", percent: 90 });
  });

  it('carries whether the facts cover only the most recent games', () => {
    expect(stats).toMatchObject({ gamesCounted: 8, limited: false });
    expect(toCareerStats([], true).limited).toBe(true);
  });

  it('copes with an empty history', () => {
    expect(toCareerStats([], false)).toEqual({ nowPlaying: null, biggestHaul: null, onTheBrink: null, gamesCounted: 0, limited: false });
  });
});

describe('toScreenshots (real payload, trimmed)', () => {
  const raw = storeDetailsResponse.content as RawStoreDetails;

  it('keeps screenshots only, each once, with https URLs and captions', () => {
    const shots = toScreenshots(raw, '9N4PT8HGCDHQ');
    expect(shots).toHaveLength(2);
    expect(shots[0]).toEqual({
      url: expect.stringMatching(/^https:\/\/store-images\.s-microsoft\.com\/image\//),
      caption: 'Marcus in front of a Corpser',
      width: 3840,
      height: 2160,
    });
    expect(shots[1]!.caption).toBe('COG squad facing the camera');
  });

  it('treats a null or blank caption as none, and a product without screenshots as empty', () => {
    const shot = (Caption: string | null) => ({ ImagePurpose: 'Screenshot', Uri: `//img.test/${Caption ?? 'null'}`, Width: 1920, Height: 1080, Caption });
    const shots = toScreenshots({ Products: [{ ProductId: 'X', LocalizedProperties: [{ Images: [shot(null), shot('  ')] }] }] }, 'X');
    expect(shots.map((s) => s.caption)).toEqual([null, null]);
    expect(toScreenshots({ Products: [{ ProductId: 'X', LocalizedProperties: [{ Images: [] }] }] }, 'X')).toEqual([]);
    expect(toScreenshots({}, 'X')).toEqual([]);
  });
});
