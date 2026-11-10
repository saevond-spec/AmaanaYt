const test = require('node:test');
const assert = require('node:assert/strict');
const { planGameplayShort } = require('../src/video-edit-plan');
const marker = (offsetSeconds, eventType = 'fight') => ({ offsetSeconds, eventType,
  confidence: 0.9, evidence: 'Visible event' });
const plan = (markers, duration = 60) => planGameplayShort(duration,
  { verified: true, eventMarkers: markers });

test('late fight keeps setup and aftermath instead of starting at segment zero', () => {
  const edit = plan([marker(42)]);
  assert.equal(edit.startSeconds, 27);
  assert.equal(edit.durationSeconds, 25);
});
test('rare loot gets a shorter window and all separated events remain visible', () => {
  assert.equal(plan([marker(30, 'rare_loot')]).durationSeconds, 15);
  const edit = plan([marker(5), marker(55)]);
  assert.equal(edit.startSeconds, 0);
  assert.equal(edit.durationSeconds, 60);
});
test('missing, unverified, malformed, and out of range evidence preserve the segment', () => {
  assert.equal(planGameplayShort(40, { eventMarkers: [marker(20)] }).mode, 'full_segment');
  assert.equal(plan([null, marker(-1), marker(61), { ...marker(20), confidence: 0.5 },
    { ...marker(20), offsetSeconds: null }]).mode, 'full_segment');
  assert.throws(() => plan([], NaN), /positive measured/);
});
test('windows remain within the measured source and retain every accepted event', () => {
  for (const duration of [5, 15, 30, 59.8]) {
    for (let offset = 0; offset < duration; offset += 0.7) {
      const edit = plan([marker(offset)], duration);
      assert.ok(edit.startSeconds >= 0);
      assert.ok(edit.startSeconds <= offset);
      assert.ok(edit.startSeconds + edit.durationSeconds >= offset);
      assert.ok(edit.startSeconds + edit.durationSeconds <= duration + 1e-9);
    }
  }
});
