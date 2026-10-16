import type { ClipMetadata } from './domain';

/** The UI route a share link sends people to. Shared contract with xbox-clips-ui. */
export function uiClipUrl(uiOrigin: string, xuid: string, clipId: string): string {
  return `${uiOrigin.replace(/\/$/, '')}/clip/${xuid}/${clipId}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * The page behind a share link. Link-preview crawlers read the Open Graph tags;
 * people are redirected to the UI. Built from stable metadata only, so it never
 * needs a media URL (PLAN-v1.md §5, "Share previews").
 */
export function renderSharePage(clip: ClipMetadata, target: string): string {
  const game = clip.gameTitle || 'Xbox';
  const title = clip.caption || `${game} clip`;
  const description = `A ${clip.durationSeconds}-second clip from ${game}.`;
  const tags = [
    ['og:type', 'video.other'],
    ['og:site_name', 'Xbox Clips'],
    ['og:title', title],
    ['og:description', description],
    ['og:url', target],
    ...(clip.thumbnailUrl ? [['og:image', clip.thumbnailUrl]] : []),
  ]
    .map(([property, content]) => `<meta property="${property}" content="${escapeHtml(content!)}">`)
    .join('\n    ');
  return page(title, target, `${tags}
    <meta name="twitter:card" content="${clip.thumbnailUrl ? 'summary_large_image' : 'summary'}">
    <meta name="description" content="${escapeHtml(description)}">`, 'Watch the clip');
}

/** Shown in place of a preview when the clip cannot be shown. Still redirects to the UI. */
export function renderShareFallback(heading: string, target: string): string {
  return page(heading, target, `<meta name="robots" content="noindex">`, heading);
}

function page(title: string, target: string, head: string, linkText: string): string {
  const url = escapeHtml(target);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    ${head}
    <link rel="canonical" href="${url}">
    <meta http-equiv="refresh" content="0; url=${url}">
  </head>
  <body>
    <p><a href="${url}">${escapeHtml(linkText)}</a></p>
  </body>
</html>
`;
}
