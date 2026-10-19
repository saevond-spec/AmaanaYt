'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeJapaneseVideoLocalization,
  draftJapaneseVideoLocalizations
} = require('../src/japanese-translation');

const source = {
  id: 'abcdefghijk',
  title: 'Apex Legends clutch #Shorts',
  description: 'Watch here: https://example.com/vod\n00:01:23 - Final fight\nFollow @Saevond'
};

 test('Japanese localization preserves URLs, hashtags, handles, and timestamps', () => {
  assert.deepEqual(normalizeJapaneseVideoLocalization({
    title: 'Apex Legendsのクラッチ #Shorts',
    description: 'ここで見てください: https://example.com/vod\n00:01:23 - 最後の戦い\n@Saevondをフォロー'
  }, source), {
    title: 'Apex Legendsのクラッチ #Shorts',
    description: 'ここで見てください: https://example.com/vod\n00:01:23 - 最後の戦い\n@Saevondをフォロー'
  });
  assert.throws(() => normalizeJapaneseVideoLocalization({
    title: 'Apex Legendsのクラッチ', description: 'ここで見てください: https://example.com/vod\n00:01:23 - 最後の戦い\n@Saevondをフォロー'
  }, source), /preserve every URL/);
});

test('Japanese localization validates YouTube title and description limits', () => {
  assert.throws(() => normalizeJapaneseVideoLocalization({ title: '日'.repeat(101), description: '' }, { title: '', description: '' }), /1–100/);
  assert.throws(() => normalizeJapaneseVideoLocalization({ title: '日本語', description: '日'.repeat(5001) }, { title: '', description: '' }), /5,000/);
  assert.equal(normalizeJapaneseVideoLocalization({ title: '日'.repeat(120), description: '' },
    { title: 'Long English playlist', description: '' }, { titleLimit: 150 }).title.length, 120);
});

test('draft translator sends bounded inputs and maps reviewed output to the exact video IDs', async () => {
  let request;
  const result = await draftJapaneseVideoLocalizations([source], {
    apiKey: 'test-key', model: 'test-model', baseUrl: 'https://api.example.test/v1',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ items: [{
        id: source.id,
        title: 'Apex Legendsのクラッチ #Shorts',
        description: 'ここで見てください: https://example.com/vod\n00:01:23 - 最後の戦い\n@Saevondをフォロー'
      }] }) } }] }) };
    }
  });
  assert.equal(request.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(request.body.model, 'test-model');
  assert.deepEqual(result, [{ id: source.id, title: 'Apex Legendsのクラッチ #Shorts',
    description: 'ここで見てください: https://example.com/vod\n00:01:23 - 最後の戦い\n@Saevondをフォロー' }]);
});

test('draft translator rejects incomplete and oversized batches before provider use', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('should not be called'); };
  await assert.rejects(draftJapaneseVideoLocalizations([], { apiKey: 'x', model: 'y', fetchImpl }), /between 1 and 5/);
  await assert.rejects(draftJapaneseVideoLocalizations(Array.from({ length: 6 }, (_, index) => ({
    id: `abcdefghij${index}`, title: 'Title', description: ''
  })), { apiKey: 'x', model: 'y', fetchImpl }), /between 1 and 5/);
  assert.equal(called, false);
});
