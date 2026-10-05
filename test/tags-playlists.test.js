const test = require('node:test');
const assert = require('node:assert/strict');
const { automaticVideoEdit } = require('../src/seo-publish');
const { chooseAutoPlaylist } = require('../src/youtube-playlists');

function item() {
  return {
    videoId: 'abcdefghijk',
    status: 'ready',
    source: {
      title: 'Funny extraction fail',
      description: 'My links: https://example.com',
      tags: Array.from({ length: 30 }, (_value, index) => `old-tag-${String(index).padStart(2, '0')}`),
      channelId: 'channel-1', privacyStatus: 'public', durationSeconds: 180
    },
    context: { takeaways: '' },
    analysis: { summary: 'Gameplay from an ARC Raiders extraction.' },
    package: {
      primaryKeyword: 'clutch extraction',
      titles: { hybrid: ['Clutch Extraction Goes Wrong'] },
      hook: 'Clutch extraction from this ARC Raiders gameplay ends unexpectedly.',
      paragraphs: ['A gameplay clip from the match.'],
      tags: ['ARC Raiders', 'Blue Gate', 'ARC Raiders Blue Gate'],
      hashtags: ['#ARCRaiders'],
      missingEvidence: []
    }
  };
}

test('generated focused tags take priority over a full legacy tag list', () => {
  const row = item();
  const edit = automaticVideoEdit(row);
  assert.deepEqual(edit.tags.slice(0, 3), row.package.tags);
  assert.equal(edit.tags.length, 30);
  assert.ok(edit.tags.includes('old-tag-00'));
  assert.ok(edit.tags.join(',').length <= 450);
});

test('playlist matching considers generated package tags as strong metadata', () => {
  const result = chooseAutoPlaylist(item(), [
    { id: 'playlist-1', title: 'ARC Raiders Blue Gate', description: '', privacyStatus: 'public' }
  ]);
  assert.equal(result.state, 'matched');
  assert.equal(result.playlist.id, 'playlist-1');
});
