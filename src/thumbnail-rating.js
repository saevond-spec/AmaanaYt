'use strict';

const METHOD = 'evidence_readability_heuristic';
const MINIMUM_SELECTION_SCORE = 60;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it',
  'of', 'on', 'or', 'the', 'to', 'was', 'were', 'with', 'your'
]);

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(value) {
  return normalize(value).split(/\s+/).filter((word) => word && !STOP_WORDS.has(word));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function evidenceText(input = {}) {
  const source = input.source || {};
  const context = input.context || {};
  const analysis = input.analysis || {};
  return [
    source.title, source.description, ...list(source.tags),
    context.takeaways, analysis.summary, analysis.visualContext,
    ...list(analysis.topics), ...list(analysis.keywords)
  ].filter((value) => typeof value === 'string' && value.trim()).join(' ');
}

function ratingLabel(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function rateCandidate(candidate, index, input, allEvidence, normalizedEvidence) {
  const overlay = String(candidate?.overlay || '').trim();
  const words = overlay.split(/\s+/).filter(Boolean);
  const validOverlay = words.length >= 1 && words.length <= 4 &&
    overlay.length <= 22 && /^[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+){0,3}$/.test(overlay);
  const normalizedOverlay = normalize(overlay);
  const grounded = validOverlay && normalizedEvidence.includes(' ' + normalizedOverlay + ' ');

  const wordPoints = words.length <= 2 ? 18 : words.length === 3 ? 16 : words.length === 4 ? 13 : 0;
  const lengthPoints = overlay.length <= 12 ? 12 : overlay.length <= 17 ? 10 : overlay.length <= 22 ? 7 : 0;
  const readable = validOverlay ? wordPoints + lengthPoints : 0;
  const contrast = validOverlay ? 5 : 0;

  const evidenceTokens = new Set(tokens(allEvidence));
  const ideaTokens = [...new Set(tokens(String(candidate?.visual || '') + ' ' + String(candidate?.hook || '')))];
  const specificity = Math.min(15, ideaTokens.filter((word) => evidenceTokens.has(word)).length * 3);

  const titleTokens = new Set(tokens(input.source?.title || ''));
  const overlayTokens = [...new Set(tokens(overlay))];
  const titleOverlap = overlayTokens.length
    ? overlayTokens.filter((word) => titleTokens.has(word)).length / overlayTokens.length
    : 1;
  const titleComplement = Math.round(10 * (1 - titleOverlap));

  const components = {
    evidence: grounded ? 40 : 0,
    readability: readable,
    contrast,
    specificity,
    titleComplement
  };
  const score = grounded ? Object.values(components).reduce((sum, value) => sum + value, 0) : 0;
  const recommendable = grounded && score >= MINIMUM_SELECTION_SCORE;
  const reasons = [];
  if (grounded) reasons.push('Overlay phrase is supported by the video evidence.');
  else if (!validOverlay) reasons.push('Overlay fails the four-word, 22-character, or plain-text readability check.');
  else reasons.push('Overlay phrase is not supported by the title, description, tags, owner notes, or video analysis.');
  if (grounded) {
    reasons.push(words.length <= 3 ? 'Overlay is concise for small-screen viewing.' : 'Overlay uses the four-word maximum.');
    reasons.push('The fixed white text, dark backing, and yellow accent provide a high-contrast treatment.');
    if (specificity) reasons.push('Visual concept shares ' + Math.floor(specificity / 3) + ' grounded topic terms.');
    if (titleComplement >= 7) reasons.push('Overlay adds wording beyond the video title.');
    else if (titleComplement <= 3) reasons.push('Overlay closely repeats wording from the video title.');
    if (!recommendable) reasons.push('Score is below the automatic selection threshold of ' + MINIMUM_SELECTION_SCORE + '.');
  }
  return { index, score, grade: ratingLabel(score), eligible: grounded, recommendable, components, reasons };
}

function rateThumbnailBriefs(briefs, input = {}) {
  const candidates = list(briefs);
  const allEvidence = evidenceText(input);
  const normalizedEvidence = ' ' + normalize(allEvidence) + ' ';
  const ratings = candidates.map((candidate, index) =>
    rateCandidate(candidate, index, input, allEvidence, normalizedEvidence));
  const selected = ratings.filter((rating) => rating.recommendable)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0] || null;
  return {
    method: METHOD,
    minimumSelectionScore: MINIMUM_SELECTION_SCORE,
    ratings,
    selectedIndex: selected ? selected.index : null,
    selected
  };
}

module.exports = { METHOD, MINIMUM_SELECTION_SCORE, rateThumbnailBriefs };
