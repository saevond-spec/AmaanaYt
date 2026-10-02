const test = require('node:test');
const assert = require('node:assert/strict');
const { auditVideo, automaticVideoEdit, channelSuggestions, channelEdit,
  createSeoPublisher } = require('../src/seo-publish');

function item(overrides = {}) {
  return {
    videoId: 'abcdefghijk',
    status: 'needs_review',
    generatedAt: '2026-10-02T00:00:00.000Z',
    source: {
      title: 'ARC Raiders first look', description: 'My links: https://example.com\nAffiliate disclosure: paid links',
      tags: ['ARC Raiders'], channelId: 'channel-1', privacyStatus: 'public', durationSeconds: 180
    },
    context: { takeaways: '' },
    analysis: { summary: 'Gameplay from ARC Raiders' },
    package: {
      primaryKeyword: 'ARC Raiders',
      titles: { hybrid: ['ARC Raiders Gameplay Highlights'] },
      hook: 'ARC Raiders gameplay and highlights from the stream.',
      paragraphs: ['A look at the match and reactions.'],
      tags: ['ARC Raiders', 'gaming highlights'],
      hashtags: ['#ARCRaiders'],
      description: '[Add verified chapters after reviewing footage]\nRelated video: [add URL]',
      missingEvidence: ['Three verified chapter markers are needed']
    },
    ...overrides
  };
}

test('automatic copy preserves existing links and disclosures without inserting placeholders or unverified chapters', () => {
  const edit = automaticVideoEdit(item());
  assert.equal(edit.title, 'ARC Raiders Gameplay Highlights');
  assert.match(edit.description, /https:\/\/example.com/);
  assert.match(edit.description, /Affiliate disclosure: paid links/);
  assert.doesNotMatch(edit.description, /\[add URL\]|Chapters/);
  assert.deepEqual(edit.tags, ['ARC Raiders', 'gaming highlights']);
  assert.ok(auditVideo(item()).some((finding) => finding.includes('keyword')));
});

test('automatic publishing requires public source and actual video evidence', () => {
  assert.throws(() => automaticVideoEdit(item({ source: { ...item().source, privacyStatus: 'private' } })),
    /Only existing public videos/);
  assert.throws(() => automaticVideoEdit(item({ analysis: null })), /Video analysis or owner/);
  assert.throws(() => automaticVideoEdit(item({
    package: { ...item().package, missingEvidence: ['Script or key takeaways needed'] }
  })), /insufficient evidence/);
});

test('regeneration replaces prior generated copy without duplicating it', () => {
  const first = item();
  const edit = automaticVideoEdit(first);
  const next = item({
    source: { ...first.source, ...edit },
    applied: { ...edit, originalDescription: first.source.description,
      originalTags: first.source.tags }
  });
  const repeated = automaticVideoEdit(next);
  assert.equal(repeated.description, edit.description);
  assert.deepEqual(repeated.tags, edit.tags);
});

test('publisher updates only a matching public video, with no visibility update', async () => {
  const row = item();
  const events = [];
  const store = {
    getSeoVideo: async () => row,
    getSeoSyncState: async () => ({ channelId: 'channel-1' }),
    markSeoApplied: async (_id, applied) => events.push(['applied', applied]),
    markSeoAutoResult: async (_id, result) => events.push(['result', result]),
    upsertSeoVideo: async (_id, source) => events.push(['source', source])
  };
  const youtube = {
    ownedChannel: async () => ({ id: 'channel-1' }),
    assertTargetChannel: async (id) => { assert.equal(id, 'channel-1'); },
    getVideo: async () => ({ snippet: { ...row.source, categoryId: '20' },
      status: { privacyStatus: 'public' } }),
    updateVideoSeo: async (_id, _video, edit) => {
      events.push(['youtube', edit]);
      assert.equal(Object.hasOwn(edit, 'status'), false);
    }
  };
  const publisher = createSeoPublisher({ store, youtube, logger: { info() {}, warn() {} } });
  await publisher.publishVideo(row.videoId);
  assert.deepEqual(events.map(([type]) => type), ['youtube', 'applied', 'source', 'result']);
  assert.equal(events.at(-1)[1].state, 'applied');
});

test('publisher does not edit private or newly unlisted videos', async () => {
  let updates = 0;
  let result;
  const row = item();
  const store = {
    getSeoVideo: async () => row,
    getSeoSyncState: async () => ({ channelId: 'channel-1' }),
    markSeoAutoResult: async (_id, value) => { result = value; }
  };
  const youtube = {
    ownedChannel: async () => ({ id: 'channel-1' }),
    assertTargetChannel: async () => {},
    getVideo: async () => ({ snippet: { ...row.source, categoryId: '20' },
      status: { privacyStatus: 'unlisted' } }),
    updateVideoSeo: async () => { updates += 1; }
  };
  const publisher = createSeoPublisher({ store, youtube, logger: { info() {}, warn() {} } });
  await publisher.publishVideo(row.videoId);
  assert.equal(updates, 0);
  assert.equal(result.state, 'skipped');
  await publisher.publishVideo(row.videoId);
  assert.equal(updates, 0);
  const privatePublisher = createSeoPublisher({
    store: { getSeoVideo: async () => item({ source: { ...row.source, privacyStatus: 'private' } }) },
    youtube, logger: { info() {}, warn() {} }
  });
  await privatePublisher.publishVideo(row.videoId);
  assert.equal(updates, 0);
});

test('channel keywords derive from analyzed public videos and retain existing description', async () => {
  const publicRow = item();
  const privateRow = item({ source: { ...item().source, privacyStatus: 'private' },
    package: { ...item().package, primaryKeyword: 'secret keyword' } });
  assert.deepEqual(channelSuggestions([publicRow, privateRow]), ['ARC Raiders']);
  const edit = channelEdit({ title: 'Saevond', description: 'Existing channel identity.',
    keywords: 'gaming', id: 'channel-1' }, ['ARC Raiders']);
  assert.deepEqual(edit, { description: 'Existing channel identity.', keywords: 'gaming "ARC Raiders"' });
  let saved = null;
  const publisher = createSeoPublisher({
    store: {
      getSeoSyncState: async () => ({ channelId: 'channel-1' }),
      listSeoVideos: async () => [publicRow, privateRow]
    },
    youtube: {
      channelSeo: async () => ({ title: 'Saevond', description: 'Existing channel identity.',
        keywords: 'gaming', id: 'channel-1' }),
      assertTargetChannel: async () => {},
      updateChannelSeo: async (_current, value) => { saved = value; }
    },
    logger: { info() {}, warn() {} }
  });
  await publisher.updateChannel();
  assert.deepEqual(saved, edit);
});
