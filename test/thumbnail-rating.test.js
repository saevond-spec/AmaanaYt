'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rateThumbnailBriefs } = require('../src/thumbnail-rating');

const evidence = {
  source: {
    title: 'ARC Raiders extraction at the Seed Vault',
    description: 'The floating raider crossed the Seed Vault during the extraction fight.',
    tags: ['ARC Raiders', 'Seed Vault', 'floating raider']
  },
  context: { takeaways: 'The fight moved to the Seed Vault.' },
  analysis: { summary: 'A floating raider appears during extraction.' }
};

test('rates three options, excludes unsupported claims, and selects the highest grounded rating', () => {
  const briefs = [
    { overlay: 'RAREST BLUEPRINT', visual: 'Blueprint close-up', hook: 'Rare blueprint found' },
    { overlay: 'FLOATING RAIDER', visual: 'Floating raider during the Seed Vault fight',
      hook: 'Unexpected extraction encounter' },
    { overlay: 'SEED VAULT', visual: 'Seed Vault extraction fight', hook: 'Fight reaches the vault' }
  ];
  const result = rateThumbnailBriefs(briefs, evidence);
  assert.equal(result.ratings.length, 3);
  assert.equal(result.ratings[0].eligible, false);
  assert.equal(result.ratings[1].eligible, true);
  assert.equal(result.ratings[2].eligible, true);
  assert.ok(result.ratings[1].score >= 60);
  assert.ok(result.ratings[2].score >= 60);
  assert.equal(result.ratings[1].components.contrast, 5);
  assert.equal(Object.values(result.ratings[1].components).reduce((sum, value) => sum + value, 0),
    result.ratings[1].score);
  assert.equal(result.selectedIndex, result.ratings[1].score > result.ratings[2].score ? 1 : 2);
  assert.equal(result.selected.score, result.ratings[result.selectedIndex].score);
  assert.match(result.method, /heuristic/);
});

test('rejects unreadable and ungrounded overlays without making a recommendation', () => {
  const result = rateThumbnailBriefs([
    { overlay: 'THIS IS WAY TOO LONG FOR A THUMBNAIL', visual: 'Seed Vault', hook: 'Seed Vault' },
    { overlay: 'FREE WIN', visual: 'Seed Vault', hook: 'Seed Vault' }
  ], evidence);
  assert.equal(result.selectedIndex, null);
  assert.equal(result.ratings[0].eligible, false);
  assert.equal(result.ratings[1].eligible, false);
});
