'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  descriptionCore,
  descriptionSimilarity,
  findMetadataConflicts,
  makeDistinctTitle,
  titleSimilarity
} = require('../src/metadata-uniqueness');

test('detects repeated and near-repeated titles while leaving distinct subjects alone', () => {
  assert.equal(titleSimilarity('Apex Legends clutch: 1v3 finale', 'Apex Legends clutch - 1v3 finale'), 1);
  assert.ok(titleSimilarity('Apex Legends clutch: 1v3 finale', 'Apex Legends clutch: 1v3 finish') >= 0.78);
  assert.ok(titleSimilarity('Apex Legends clutch: 1v3 finale', 'Fortnite ranked endgame guide') < 0.78);
});

test('compares description substance and ignores repeated link, chapter, and hashtag templates', () => {
  const first = [
    'Apex Legends ranked: Saevond escapes the final ring after a last-second shield swap.',
    'Watch the squad rotate through Fragment, recover a banner, and win the final 1v3 with careful timing.',
    '', 'Chapters', '0:00 - Landing', '0:48 - Final ring', '',
    'Full Twitch VOD: https://www.twitch.tv/videos/123456', '#Saevond #Gaming #Shorts'
  ].join('\n');
  const repeated = first.replace('https://www.twitch.tv/videos/123456', 'https://www.twitch.tv/videos/654321');
  const distinct = first.replace('shield swap', 'arc star push').replace('recover a banner', 'break a wall and reset');
  assert.match(descriptionCore(first), /last-second shield swap/);
  assert.doesNotMatch(descriptionCore(first), /123456|Chapters/);
  assert.equal(descriptionSimilarity(first, repeated), 1);
  assert.ok(descriptionSimilarity(first, distinct) < 0.88);
});

test('reports cross-video conflicts but ignores the current video and shared boilerplate', () => {
  const duplicateDescription = 'Apex Legends ranked: Saevond escapes the final ring after a last-second shield swap.\n' +
    'Watch the squad rotate through Fragment, recover a banner, and win the final 1v3 with careful timing.\n' +
    'Full Twitch VOD: https://www.twitch.tv/videos/999999\n#Saevond #Gaming';
  const conflicts = findMetadataConflicts({
    videoId: 'current',
    title: 'Apex Legends clutch: 1v3 finale',
    description: duplicateDescription,
    peers: [
      { videoId: 'current', title: 'Apex Legends clutch: 1v3 finale', description: duplicateDescription },
      { videoId: 'older', title: 'Apex Legends clutch - 1v3 finale', description: duplicateDescription }
    ]
  });
  assert.deepEqual(conflicts.map((item) => item.kind), ['title', 'description']);
  assert.equal(conflicts[0].videoId, 'older');
});

test('near-duplicate bundle titles also gain a factual timestamp', () => {
  const first = 'Apex Legends clutch: 1v3 finale';
  const nearDuplicate = 'Apex Legends clutch: 1v3 finale highlight';
  assert.ok(titleSimilarity(first, nearDuplicate) >= 0.78);
  const second = makeDistinctTitle(nearDuplicate, 'at 0:47', [first], 100);
  assert.ok(second.includes('| at 0:47'));
  assert.ok(second.length <= 100);
});

test('repeated bundle titles gain a factual timestamp and stay under YouTube title limit', () => {
  const first = 'Last ring shield swap wins the final Apex Legends fight';
  const second = makeDistinctTitle(first, 'at 0:42', [first], 100);
  assert.ok(second.startsWith(`${first} | at 0:42`));
  assert.ok(second.length <= 100);
  assert.notEqual(require('../src/metadata-uniqueness').canonicalText(second),
    require('../src/metadata-uniqueness').canonicalText(first));
  assert.throws(() => makeDistinctTitle(first, '', [first]), /factual detail/);
});
