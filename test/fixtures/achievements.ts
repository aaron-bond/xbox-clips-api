/**
 * Real achievement responses (2026-10-18), trimmed. `currentAchievementsResponse`
 * is GET /v2/achievements/player/{xuid}/{titleId} for Assassin's Creed Black Flag
 * Resynced: one unlocked, one in progress and one secret locked achievement of 49.
 * `x360AchievementsResponse` is GET /v2/achievements/x360/{xuid}/title/{titleId}
 * for Halo 4: two of the 59 unlocked achievements it lists (locked ones aren't
 * listed at all). Unused fields are removed.
 */
export const currentAchievementsResponse = {
  "content": {
    "achievements": [
      {
        "id": "8",
        "name": "Articles Of Agreement",
        "titleAssociations": [
          {
            "name": "Assassin's Creed Black Flag",
            "id": 1661962317
          }
        ],
        "progressState": "Achieved",
        "progression": {
          "requirements": [],
          "timeUnlocked": "2026-09-10T02:02:31.2500000Z"
        },
        "mediaAssets": [
          {
            "name": "9fb5a166-5f19-40ef-89d1-daa06d96fc16",
            "type": "Icon",
            "url": "https://images-eds-ssl.xboxlive.com/image?url=27S1DHqE.cHkmFg4nspsd4bBpXXaatBocoDC6B0FXLtv9yk4M59IZzvFoNIL8MkluZXZ.DXNR19L8Vzj3LoWVEFz7rpPFwMlDvQFaqyZobGH5iKlGILxdDlm39HGo687bfXLXJzCaoUWCkxwLTdG8UWsoo_EXoUlJtHtYxT8YuoSJa1IAZ5ZDYLJSgfJy5CX"
          }
        ],
        "isSecret": false,
        "description": "Ensure the survival of all pirates in a street fight",
        "lockedDescription": "Ensure the survival of all pirates in a street fight",
        "rewards": [
          {
            "name": null,
            "description": null,
            "value": "10",
            "type": "Gamerscore",
            "mediaAsset": null,
            "valueType": "Int"
          }
        ],
        "rarity": {
          "currentCategory": "Common",
          "currentPercentage": 59.34
        }
      },
      {
        "id": "17",
        "name": "The Hangman",
        "titleAssociations": [
          {
            "name": "Assassin's Creed Black Flag",
            "id": 1661962317
          }
        ],
        "progressState": "InProgress",
        "progression": {
          "requirements": [
            {
              "id": "00000000-0000-0000-0000-000000000000",
              "current": "60",
              "target": "100",
              "operationType": "Sum",
              "valueType": "Integer",
              "ruleParticipationType": "Individual"
            }
          ],
          "timeUnlocked": "0001-01-01T00:00:00.0000000Z"
        },
        "mediaAssets": [
          {
            "name": "cf103943-f23f-4b98-aafb-d333b3769fd4",
            "type": "Icon",
            "url": "https://images-eds-ssl.xboxlive.com/image?url=27S1DHqE.cHkmFg4nspsd3u2yzeZlxOl2mt5ZxBvVVJ4K3UCaQ6.F0QwYhoVoXI5txhzAAdHvYu9OVw8CKRrYOgnGuY3mll9hnnLyWMgtZS_emKBHYSO0N8o44krSKDbtzbir2s1OiKuVG3bOK27msEkubZglyNBbnPLA9TUu18-"
          }
        ],
        "isSecret": false,
        "description": "Kill 10 enemies by hanging them with the rope dart",
        "lockedDescription": "Kill 10 enemies by hanging them with the rope dart",
        "rewards": [
          {
            "name": null,
            "description": null,
            "value": "20",
            "type": "Gamerscore",
            "mediaAsset": null,
            "valueType": "Int"
          }
        ],
        "rarity": {
          "currentCategory": "Common",
          "currentPercentage": 16.75
        }
      },
      {
        "id": "1",
        "name": "Last To Leave",
        "titleAssociations": [
          {
            "name": "Assassin's Creed Black Flag",
            "id": 1661962317
          }
        ],
        "progressState": "NotStarted",
        "progression": {
          "requirements": [
            {
              "id": "00000000-0000-0000-0000-000000000000",
              "current": "0",
              "target": "100",
              "operationType": "Sum",
              "valueType": "Integer",
              "ruleParticipationType": "Individual"
            }
          ],
          "timeUnlocked": "0001-01-01T00:00:00.0000000Z"
        },
        "mediaAssets": [
          {
            "name": "6bc5f7fa-a100-449f-9177-0191aae60a58",
            "type": "Icon",
            "url": "https://images-eds-ssl.xboxlive.com/image?url=27S1DHqE.cHkmFg4nspsdzFE2UouE0PBVnXmPj8VTGcIhnZlVITT.noH0PsDRQlxMkHBkHs_zB8xx56g88Zn0hgYdkD5CBq82Pee33B_dLJ5uLeVwKjKda7jge5EQDbv1gh.UQJ1UAF0W9AlK6oSoNFeVKlz36iM8TcOqUD1KGg-"
          }
        ],
        "isSecret": true,
        "description": "Take a seat on a burning ship",
        "lockedDescription": "Take a seat on a burning ship",
        "rewards": [
          {
            "name": null,
            "description": null,
            "value": "50",
            "type": "Gamerscore",
            "mediaAsset": null,
            "valueType": "Int"
          }
        ],
        "rarity": {
          "currentCategory": "Common",
          "currentPercentage": 10.7
        }
      }
    ],
    "pagingInfo": {
      "continuationToken": null,
      "totalRecords": 49
    }
  },
  "code": 200
};

export const x360AchievementsResponse = {
  "content": {
    "achievements": [
      {
        "id": 173,
        "titleId": 1297287449,
        "name": "Outta My Way!",
        "unlocked": true,
        "isSecret": false,
        "gamerscore": 40,
        "imageId": 244,
        "description": "In Castle DLC matchmaking, killed 5 enemies during a match by running them over.",
        "lockedDescription": "In Castle DLC matchmaking, kill 5 enemies during a match by running them over.",
        "timeUnlocked": "2017-09-23T23:43:20.6900000Z",
        "rarity": {
          "currentCategory": "Rare",
          "currentPercentage": 1.03
        }
      },
      {
        "id": 170,
        "titleId": 1297287449,
        "name": "Beating Up the Beat",
        "unlocked": true,
        "isSecret": false,
        "gamerscore": 30,
        "imageId": 241,
        "description": "In Castle DLC matchmaking, performed 5 melee kills in a single match.",
        "lockedDescription": "In Castle DLC matchmaking, perform 5 melee kills in a single match.",
        "timeUnlocked": "2017-09-23T23:43:20.4800000Z",
        "rarity": {
          "currentCategory": "Rare",
          "currentPercentage": 1.96
        }
      }
    ],
    "pagingInfo": {
      "continuationToken": null,
      "totalRecords": 59
    }
  },
  "code": 200
};
