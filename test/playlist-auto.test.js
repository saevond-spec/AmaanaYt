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


test('playlist quota day follows YouTube midnight Pacific reset', () => {
  assert.equal(youtubeQuotaDate(Date.parse('2026-10-03T06:30:00Z')), '2026-10-02');
  assert.equal(youtubeQuotaDate(Date.parse('2026-10-03T08:00:00Z')), '2026-10-03');
});
