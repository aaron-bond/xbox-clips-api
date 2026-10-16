import { describe, expect, it } from 'vitest';
import { pickSearchMatch, toClip, toClipPage, toProfile } from '../src/provider/openxbl-transform';
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
    });
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
