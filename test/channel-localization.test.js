const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_CHANNEL_DESCRIPTION_LENGTH,
  draftJapaneseChannelLocalization,
  normalizeJapaneseChannelLocalization
} = require('../src/channel-localization');

test('Japanese channel draft keeps the creator name and preserves source links', () => {
  const draft = draftJapaneseChannelLocalization({
    title: 'Saevond',
    description: 'English profile\nTwitch: https://twitch.tv/saevond\nTwitch: https://twitch.tv/saevond'
  });

  assert.equal(draft.title, 'Saevond');
  assert.match(draft.description, /NARAKA: BLADEPOINTのパートナー/);
  assert.match(draft.description, /実況なしのゲームプレイ動画/);
  assert.equal((draft.description.match(/https:\/\/twitch\.tv\/saevond/g) || []).length, 1);
  assert.deepEqual(draft.preservedLinks, ['Twitch: https://twitch.tv/saevond']);
});

test('Japanese channel localization trims text and accepts a brand name in Latin characters', () => {
  assert.deepEqual(normalizeJapaneseChannelLocalization({
    title: ' Saevond ', description: '  日本語のチャンネル紹介です。  '
  }), { title: 'Saevond', description: '日本語のチャンネル紹介です。' });
});

test('Japanese channel localization rejects empty, non-Japanese, and over-limit descriptions', () => {
  assert.throws(() => normalizeJapaneseChannelLocalization({ title: 'Saevond', description: '' }),
    /description must be/);
  assert.throws(() => normalizeJapaneseChannelLocalization({ title: 'Saevond', description: 'Gaming channel' }),
    /must contain Japanese/);
  assert.throws(() => normalizeJapaneseChannelLocalization({
    title: 'Saevond', description: '日'.repeat(MAX_CHANNEL_DESCRIPTION_LENGTH + 1)
  }), /description must be/);
});
