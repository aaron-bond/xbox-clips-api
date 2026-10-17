import { describe, expect, it } from 'vitest';
import { pickDescription, pickSearchMatch, toCareerStats, toClip, toClipPage, toMostPlayed, toProfile, type RawMostPlayed, type RawTitleHistory } from '../src/provider/openxbl-transform';
import { titlesResponse } from './fixtures/titles';
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

describe('toCareerStats (real payload, trimmed)', () => {
  const stats = toCareerStats(titlesResponse.content as unknown as RawTitleHistory);

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

  it('counts games per platform, oldest generation first', () => {
    expect(stats.platforms).toEqual([
      { platform: 'Xbox 360', games: 3 },
      { platform: 'Xbox One', games: 6 },
      { platform: 'Xbox Series X|S', games: 8 },
      { platform: 'PC', games: 1 },
    ]);
  });

  it('flags a history cut off at 1,000 games', () => {
    expect(stats.capped).toBe(false);
    const many = { titles: Array.from({ length: 1000 }, (_, i) => ({ titleId: String(i), name: `G${i}`, type: 'Game' })) };
    expect(toCareerStats(many).capped).toBe(true);
  });

  it('copes with an empty history', () => {
    expect(toCareerStats({})).toEqual({ nowPlaying: null, biggestHaul: null, onTheBrink: null, platforms: [], gamesCounted: 0, capped: false });
  });
});
