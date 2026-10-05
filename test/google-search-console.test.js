const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGoogleSearchConsoleCsv, extractVideoId } = require('../src/google-search-console');

test('imports video page metrics and derives impression-weighted average position', () => {
  const csv = '\uFEFFTop pages,Clicks,Impressions,CTR,Position\r\n' +
    '"https://www.youtube.com/watch?v=abcdefghijk",12,100,12%,4.5\r\n' +
    '"https://www.youtube.com/shorts/abcdefghijk",3,50,6%,8.5\r\n' +
    '"https://www.youtube.com/playlist?list=PL123",100,1000,10%,1.2\r\n' +
    '"https://example.com/watch?v=abcdefghijk",99,999,9.9%,2\r\n';
  assert.deepEqual(parseGoogleSearchConsoleCsv(csv), [{
    videoId: 'abcdefghijk', clicks: 15, impressions: 150, averagePosition: 5.8333
  }]);
});

test('recognizes YouTube video formats and rejects playlist or unrelated URLs', () => {
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
  assert.equal(extractVideoId('https://youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(extractVideoId('https://youtube.com/live/abcdefghijk'), 'abcdefghijk');
  assert.equal(extractVideoId('https://youtube.com/embed/abcdefghijk'), 'abcdefghijk');
  assert.equal(extractVideoId('https://youtu.be/abcdefghijk'), 'abcdefghijk');
  assert.equal(extractVideoId('https://youtube.com/playlist?list=abcdefghijk'), null);
  assert.equal(extractVideoId('https://example.com/watch?v=abcdefghijk'), null);
});

test('rejects query exports and CSVs with no YouTube video URLs', () => {
  assert.throws(() => parseGoogleSearchConsoleCsv('Query,Clicks,Impressions,Position\ngame,1,2,3'),
    /Pages or Posts CSV/);
  assert.throws(() => parseGoogleSearchConsoleCsv(
    'Page,Clicks,Impressions,CTR,Position\nhttps://example.com/video,1,2,50%,3'),
  /No YouTube video URLs/);
});

test('accepts a locale decimal comma in a quoted average-position cell', () => {
  const csv = 'Top pages,Clicks,Impressions,CTR,Position\n' +
    '"https://www.youtube.com/watch?v=abcdefghijk",2,3,66.7%,"2,5"\n';
  assert.deepEqual(parseGoogleSearchConsoleCsv(csv), [{
    videoId: 'abcdefghijk', clicks: 2, impressions: 3, averagePosition: 2.5
  }]);
});
