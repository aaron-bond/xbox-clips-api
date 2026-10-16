import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { DEFAULT_CLIP_LIMIT, MAX_CLIP_LIMIT, parseClipId, parseLimit, parsePlayerIdentifier, parseXuid } from '../src/validation';

describe('parsePlayerIdentifier', () => {
  it('treats all-digit identifiers as XUIDs', () => {
    expect(parsePlayerIdentifier('2533274900000001')).toEqual({ kind: 'xuid', xuid: '2533274900000001' });
  });

  it.each(['TestPlayer', 'Major Nelson', 'Kåre', 'プレイヤー', 'Player#1234', 'A'])('accepts gamertag %s', (g) => {
    expect(parsePlayerIdentifier(g)).toEqual({ kind: 'gamertag', gamertag: g });
  });

  it.each(['', ' Leading', 'Trailing ', 'semi;colon', 'a/b', 'x'.repeat(16), '../etc', 'tag#', '1'.repeat(21)])(
    'rejects %j',
    (g) => {
      expect(() => parsePlayerIdentifier(g)).toThrow(AppError);
    },
  );
});

describe('parseXuid / parseClipId', () => {
  it('validates XUIDs', () => {
    expect(parseXuid('123')).toBe('123');
    expect(() => parseXuid('12a')).toThrow(AppError);
  });

  it('validates and lower-cases clip ids', () => {
    expect(parseClipId('0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D')).toBe('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
    expect(() => parseClipId('not-a-uuid')).toThrow(AppError);
  });
});

describe('parseLimit', () => {
  it('defaults, clamps and falls back', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_CLIP_LIMIT);
    expect(parseLimit('5')).toBe(5);
    expect(parseLimit('100000')).toBe(MAX_CLIP_LIMIT);
    expect(parseLimit('0')).toBe(DEFAULT_CLIP_LIMIT);
    expect(parseLimit('abc')).toBe(DEFAULT_CLIP_LIMIT);
    expect(parseLimit('2.5')).toBe(DEFAULT_CLIP_LIMIT);
  });
});
