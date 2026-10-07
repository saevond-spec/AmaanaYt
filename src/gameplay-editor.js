'use strict';

const EDIT_STYLES = Object.freeze(['story', 'chronological']);

function buildGameplayEditPlan(highlights, requestedStyle = 'story') {
  if (!Array.isArray(highlights) || highlights.length < 1 || highlights.length > 8) {
    throw new Error('A gameplay edit needs between one and eight validated moments');
  }
  const style = requestedStyle == null ? 'story' : String(requestedStyle);
  if (!EDIT_STYLES.includes(style)) {
    throw new Error('editingStyle must be story or chronological');
  }

  const starts = highlights.map((moment, index) => {
    const start = Number(moment && moment.startSeconds);
    if (!Number.isFinite(start) || start < 0) {
      throw new Error('Every gameplay moment needs a measured non-negative start time');
    }
    const rawScore = moment && moment.score;
    const score = rawScore === null || rawScore === undefined || rawScore === ''
      ? null : Number(rawScore);
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) {
      throw new Error('Every supplied gameplay score must be between 0 and 100');
    }
    return { index, start, score };
  });

  const chronologicalIndexes = starts
    .slice()
    .sort((left, right) => left.start - right.start || left.index - right.index)
    .map((item) => item.index);
  let hookIndex = null;
  if (style === 'story') {
    const scored = starts.filter((item) => item.score !== null && item.score > 0)
      .sort((left, right) => right.score - left.score ||
        left.start - right.start || left.index - right.index);
    if (scored.length) hookIndex = scored[0].index;
  }

  const orderedIndexes = hookIndex === null
    ? chronologicalIndexes
    : [hookIndex, ...chronologicalIndexes.filter((index) => index !== hookIndex)];
  const originalIndexes = highlights.map((_moment, index) => index);
  return {
    version: 1,
    style,
    profile: style === 'story' ? 'gameplay_story_first' : 'gameplay_chronological',
    hookIndex,
    hookTitle: hookIndex === null ? null : String(highlights[hookIndex].title || '').slice(0, 100),
    orderedIndexes,
    reordered: orderedIndexes.some((index, position) => index !== originalIndexes[position]),
    preservesAllMoments: orderedIndexes.length === highlights.length &&
      new Set(orderedIndexes).size === highlights.length
  };
}

module.exports = { EDIT_STYLES, buildGameplayEditPlan };
