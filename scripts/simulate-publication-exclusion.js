'use strict';

// Deterministic transaction-order model for the parent-row/advisory-lock protocol.
// This is an interleaving simulation, not a PostgreSQL integration test.
const assert = require('node:assert/strict');

function permutations(values) {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, itemIndex) => itemIndex !== index)).map((rest) => [value, ...rest]));
}

function run(order) {
  const state = { parent: 'awaiting_owner_approval', publication: 'pending', shorts: new Map(),
    exclusionsBlocked: 0, claimsRejected: 0, shortsRejected: 0,
    shortInsertedAfterPublication: false };
  for (const operation of order) {
    if (operation === 'claim') {
      if (state.parent === 'excluded_by_owner' || state.publication !== 'pending') {
        state.claimsRejected += 1;
      } else {
        state.parent = 'publication_in_progress';
        state.publication = 'publishing';
      }
    } else if (operation === 'exclude') {
      if (state.publication === 'publishing' || state.publication === 'ambiguous' ||
          state.publication === 'published' || state.publication === 'scheduled') {
        state.exclusionsBlocked += 1;
      } else {
        state.parent = 'excluded_by_owner';
        state.publication = 'excluded';
        for (const [id, status] of state.shorts) {
          if (status === 'pending') state.shorts.set(id, 'excluded');
        }
      }
    } else if (operation === 'addShort') {
      if (state.parent === 'excluded_by_owner' ||
          ['publishing', 'ambiguous', 'published', 'scheduled', 'excluded'].includes(state.publication)) {
        state.shortsRejected += 1;
      } else {
        if (state.publication !== 'pending') state.shortInsertedAfterPublication = true;
        state.shorts.set('short-' + state.shorts.size, 'pending');
      }
    } else if (operation === 'youtubeAck' && state.publication === 'publishing') {
      state.parent = 'published';
      state.publication = 'published';
    }
  }
  assert.equal(state.parent === 'excluded_by_owner' &&
    ['publishing', 'ambiguous', 'published', 'scheduled'].includes(state.publication), false,
    `publication/exclusion conflict: ${order.join(',')}`);
  assert.equal(state.parent === 'excluded_by_owner' && [...state.shorts.values()].includes('pending'), false,
    `late Short escaped group exclusion: ${order.join(',')}`);
  assert.equal(state.shortInsertedAfterPublication, false,
    `Short inserted after publication: ${order.join(',')}`);
  return state;
}

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

const schedules = permutations(['claim', 'exclude', 'addShort']);
for (const schedule of schedules) run(schedule);

const totals = { claimAttempts: 0, exclusionsBlocked: 0, claimsRejected: 0, shortsRejected: 0 };
// Fuzz repeated claims/exclusions, late child inserts, and YouTube acknowledgements.
for (let index = 0; index < 100_000; index += 1) {
  const rng = random(index + 1);
  const schedule = [];
  for (let count = 1 + Math.floor(rng() * 3); count > 0; count -= 1) schedule.push('claim');
  for (let count = 1 + Math.floor(rng() * 3); count > 0; count -= 1) schedule.push('exclude');
  for (let count = 1 + Math.floor(rng() * 5); count > 0; count -= 1) schedule.push('addShort');
  for (let count = Math.floor(rng() * 3); count > 0; count -= 1) schedule.push('youtubeAck');
  for (let cursor = schedule.length - 1; cursor > 0; cursor -= 1) {
    const swap = Math.floor(rng() * (cursor + 1));
    [schedule[cursor], schedule[swap]] = [schedule[swap], schedule[cursor]];
  }
  const outcome = run(schedule);
  totals.claimAttempts += schedule.filter((event) => event === 'claim').length;
  totals.exclusionsBlocked += outcome.exclusionsBlocked;
  totals.claimsRejected += outcome.claimsRejected;
  totals.shortsRejected += outcome.shortsRejected;
}

process.stdout.write(JSON.stringify({
  result: 'PASS', exhaustiveBaseOrders: schedules.length, fuzzedMultiEventSchedules: 100_000,
  ...totals, databaseConcurrency: 'not exercised; transaction-order state-machine model'
}, null, 2) + '\n');
