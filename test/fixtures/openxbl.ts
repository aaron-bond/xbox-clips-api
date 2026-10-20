/**
 * OpenXBL payloads with the exact shape of live responses captured on
 * 2026-10-16, including the { content, code } envelope and integer enums.
 * Identifiers, names and signatures are fictional.
 */

export const XUID = '2533274900000001';
export const CLIP_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

export const searchResponse = {
  content: {
    people: [
      {
        xuid: XUID,
        isFavorite: false,
        displayName: null,
        realName: '',
        displayPicRaw: 'https://images-eds-ssl.xboxlive.com/image?url=example&format=png',
        gamertag: 'TestPlayer',
        gamerScore: '12345',
        modernGamertag: 'TestPlayer',
        modernGamertagSuffix: '',
        uniqueModernGamertag: 'TestPlayer',
        xboxOneRep: 'GoodPlayer',
      },
      { xuid: '2533274900000002', gamertag: 'TestPlayer2', modernGamertag: 'TestPlayer2', uniqueModernGamertag: 'TestPlayer2' },
    ],
  },
  code: 200,
};

export const accountResponse = {
  content: {
    profileUsers: [
      {
        id: XUID,
        hostId: XUID,
        settings: [
          { id: 'Gamertag', value: 'TestPlayer' },
          { id: 'GameDisplayPicRaw', value: 'https://images-eds-ssl.xboxlive.com/image?url=example&format=png' },
          { id: 'Gamerscore', value: '12345' },
          { id: 'AccountTier', value: 'Gold' },
          { id: 'XboxOneRep', value: 'GoodPlayer' },
          { id: 'ModernGamertag', value: 'TestPlayer' },
          { id: 'ModernGamertagSuffix', value: '' },
          { id: 'UniqueModernGamertag', value: 'TestPlayer' },
          { id: 'Bio', value: '  Clips from the couch.  ' },
          { id: 'Location', value: '' },
          { id: 'TenureLevel', value: '19' },
          { id: 'XboxOneRep', value: 'GoodPlayer' },
        ],
        isSponsoredUser: false,
      },
    ],
  },
  code: 200,
};

export const EXPIRATION = '2026-10-01T19:20:30.0000000Z';

export const rawClip = {
  gameClipId: CLIP_ID,
  state: 6,
  datePublished: '2026-10-01T18:20:30.1234567Z',
  dateRecorded: '2026-10-01T18:19:00Z',
  lastModified: '2026-10-01T18:20:30.1234567Z',
  userCaption: '',
  type: 8,
  durationInSeconds: 29,
  scid: '00000000-0000-4000-8000-000000000000',
  titleId: 1234567890,
  rating: 0,
  ratingCount: 0,
  views: 2,
  titleData: '',
  systemProperties: '',
  savedByUser: true,
  achievementId: '',
  greatestMomentId: '',
  thumbnails: [
    {
      uri: `https://gameclipscontent-t1001.media.xboxlive.com/xuid-${XUID}-public/${CLIP_ID}_Thumbnail.PNG`,
      fileSize: 0,
      thumbnailType: 1,
    },
    {
      uri: `https://gameclipscontent-t1001.media.xboxlive.com/xuid-${XUID}-public/${CLIP_ID}_Thumbnail.PNG`,
      fileSize: 0,
      thumbnailType: 2,
    },
  ],
  gameClipUris: [
    {
      uri: `https://gameclipscontent-d1001.media.xboxlive.com/xuid-${XUID}-private/${CLIP_ID}.MP4?sv=2026-02-06&si=DefaultAccess&sr=b&sig=FAKE&__gda__=1790000000_fake`,
      fileSize: 50000000,
      uriType: 2,
      expiration: EXPIRATION,
    },
  ],
  xuid: XUID,
  clipName: '',
  titleName: 'Example Game',
  gameClipLocale: 'en-US',
  clipContentAttributes: 0,
  deviceType: 'Scarlett',
  commentCount: 0,
  likeCount: 0,
  shareCount: 0,
  partialViews: 0,
};

export const clipsResponse = {
  content: { gameClips: [rawClip], pagingInfo: { continuationToken: null } },
  code: 200,
};

/**
 * A real GET /v2/dvr/gameclips/{xuid} response (2026-10-20) for a player whose
 * clips aren't public: HTTP 200 from OpenXBL, carrying Xbox's GameMedia error
 * 10209 with an inner 403.
 */
export const privateClipsResponse = {
  content: { errorMessage: 'GameMedia Error Code', HttpStatusCode: 403, errorCode: 10209 },
  code: 403,
};
