const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPlaylistAutoAssigner, youtubeQuotaDate } = require('../src/playlist-auto');

test('automatic assignment reserves a daily slot and adds only confident matches', async () => {
  const reservations = [];
  const additions = [];
  const assigner = createPlaylistAutoAssigner({
    env: { YOUTUBE_AUTO_PLAYLIST_DAILY_LIMIT: '3' },
    now: () => Date.parse('2026-10-03T12:00:00Z'),
    store: { reservePlaylistAutoSlot: async (...args) => { reservations.push(args); return { allowed: true }; } },
    youtube: {
      listOwnedPlaylists: async () => [
        { id: 'PL1', title: 'ARC Raiders', description: '', privacyStatus: 'private' }
      ],
      addVideoToPlaylist: async (args) => { additions.push(args); return { alreadyAdded: false }; }
    },
    logger: { warn() {} }
  });
  const result = await assigner.assign({
    id: 'abcdefghijk', title: 'ARC Raiders clutch extraction',
    tags: ['gaming'], privacyStatus: 'private'
  });
  assert.equal(result.state, 'added');
  assert.equal(result.playlistId, 'PL1');
  assert.equal(additions[0].videoId, 'abcdefghijk');
  assert.deepEqual(reservations[0], ['private', 3, '2026-10-03']);
});

test('daily cap defers assignment without playlist API writes', async () => {
  let listed = false;
  const assigner = createPlaylistAutoAssigner({
    store: { reservePlaylistAutoSlot: async () => ({ allowed: false }) },
    youtube: { listOwnedPlaylists: async () => { listed = true; return []; } }
  });
  assert.equal((await assigner.assign({
    id: 'abcdefghijk', privacyStatus: 'public', title: 'ARC Raiders'
  })).state, 'daily_limit');
  assert.equal(listed, false);
});


test('catalog backlog classifies private and unlisted videos into private playlists only', async () => {
  const reservations = [];
  const additions = [];
  const results = [];
  const candidates = [
    { videoId: 'abcdefghijk', source: { title: 'ARC Raiders clutch extraction',
      description: '', tags: ['ARC Raiders'], privacyStatus: 'private' } },
    { videoId: 'lmnopqrstuv', source: { title: 'Naraka Bladepoint Songbird Arena',
      description: '', tags: ['Naraka Bladepoint'], privacyStatus: 'unlisted' } }
  ];
  const assigner = createPlaylistAutoAssigner({
    store: {
      listSeoNeedsPlaylist: async () => candidates,
      markSeoPlaylistResult: async (id, result) => results.push([id, result]),
      reservePlaylistAutoSlot: async (privacyStatus) => {
        reservations.push(privacyStatus);
        return { allowed: true };
      }
    },
    youtube: {
      listOwnedPlaylists: async () => [
        { id: 'PL-arc-private', title: 'ARC Raiders', privacyStatus: 'private' },
        { id: 'PL-arc-public', title: 'ARC Raiders', privacyStatus: 'public' },
        { id: 'PL-naraka-private', title: 'Naraka Bladepoint', privacyStatus: 'private' },
        { id: 'PL-naraka-public', title: 'Naraka Bladepoint', privacyStatus: 'public' }
      ],
      addVideoToPlaylist: async (input) => { additions.push(input); return { alreadyAdded: false }; }
    },
    logger: { warn() {} }
  });
  const result = await assigner.assignCatalogBacklog();
  assert.deepEqual(reservations, ['private', 'unlisted']);
  assert.equal(result.attempted, 2);
  assert.equal(result.assigned, 2);
  assert.deepEqual(additions, [
    { playlistId: 'PL-arc-private', videoId: 'abcdefghijk' },
    { playlistId: 'PL-naraka-private', videoId: 'lmnopqrstuv' }
  ]);
  assert.ok(results.every(([, value]) => value.privacyStatus === 'private'));
});

test('playlist quota day follows YouTube midnight Pacific reset', () => {
  assert.equal(youtubeQuotaDate(Date.parse('2026-10-03T06:30:00Z')), '2026-10-02');
  assert.equal(youtubeQuotaDate(Date.parse('2026-10-03T08:00:00Z')), '2026-10-03');
});
