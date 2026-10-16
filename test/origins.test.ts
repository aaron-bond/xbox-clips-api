import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, parseAllowedOrigins } from '../src/origins';

const allowed = parseAllowedOrigins(
  'https://xboxclips.io, https://*.xbox-clips-ui.pages.dev ,http://localhost:5173',
);

describe('isAllowedOrigin', () => {
  it.each(['https://xboxclips.io', 'http://localhost:5173', 'https://main.xbox-clips-ui.pages.dev', 'https://a1b2c3.xbox-clips-ui.pages.dev'])(
    'allows %s',
    (origin) => {
      expect(isAllowedOrigin(origin, allowed)).toBe(true);
    },
  );

  it.each([
    ['another site', 'https://evil.example'],
    ['the wildcard suffix itself', 'https://xbox-clips-ui.pages.dev'],
    ['a lookalike suffix', 'https://evilxbox-clips-ui.pages.dev'],
    ['the suffix inside another domain', 'https://x.xbox-clips-ui.pages.dev.evil.example'],
    ['the wrong scheme', 'http://main.xbox-clips-ui.pages.dev'],
    ['an added port', 'https://main.xbox-clips-ui.pages.dev:8443'],
    ['a different port on an exact entry', 'http://localhost:3000'],
    ['a path, which is not an origin', 'https://xboxclips.io/'],
    ['garbage', 'not a url'],
    ['the literal null origin', 'null'],
  ])('rejects %s', (_label, origin) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(false);
  });
});
