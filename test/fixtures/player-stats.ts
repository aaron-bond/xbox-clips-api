/**
 * Real POST /v2/player/stats responses (2026-10-18) for MinutesPlayed:
 * `minutesPlayedResponse` for Assassin's Creed Black Flag Resynced, and
 * `noStatsResponse` for an Xbox 360 game, where the collection is empty.
 */
export const minutesPlayedResponse = {
  "content": {
    "groups": [],
    "statlistscollection": [
      {
        "arrangebyfield": "xuid",
        "arrangebyfieldid": "2584878536129841",
        "stats": [
          {
            "groupproperties": {},
            "xuid": "2584878536129841",
            "scid": "00000000-0000-0000-0000-0000630f884d",
            "titleid": "1661962317",
            "name": "MinutesPlayed",
            "type": "Integer",
            "value": "2019",
            "properties": {}
          }
        ]
      }
    ]
  },
  "code": 200
};

export const noStatsResponse = {
  "content": {
    "groups": [],
    "statlistscollection": []
  },
  "code": 200
};
