'use strict';

const GENERIC_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'how',
  'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'this', 'to', 'was', 'what',
  'when', 'with', 'you', 'your', 'saevond', 'gaming', 'gameplay', 'video', 'videos',
  'watch', 'subscribe', 'short', 'shorts', 'livestream', 'stream', 'highlight',
  'highlights', 'moment', 'moments', 'best'
]);
const TITLE_DUPLICATE_THRESHOLD = 0.78;

function canonicalText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/[#@][\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function usefulTokens(value) {
  return new Set((canonicalText(value).match(/[\p{L}\p{N}]+/gu) || [])
    .filter((token) => !GENERIC_TOKENS.has(token) && (token.length > 1 || /^\d$/u.test(token))));
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function titleSimilarity(left, right) {
  const a = canonicalText(left);
  const b = canonicalText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const leftTokens = usefulTokens(left);
  const rightTokens = usefulTokens(right);
  if (Math.min(leftTokens.size, rightTokens.size) < 3) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function descriptionCore(value) {
  const lines = String(value || '').split(/\r?\n/u);
  const content = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(chapters?|timestamps?|resources|links)\s*:?$/iu.test(line)) break;
    if (/^(?:related video|highlight video|full twitch vod|source|playlist|affiliate\s*\/\s*cta|affiliate disclosure)\s*:/iu.test(line)) continue;
    if (/^#[\p{L}\p{N}_]+(?:\s+#[\p{L}\p{N}_]+)*$/u.test(line)) continue;
    if (/^\[?(?:add|insert|replace|your|tbd|todo)[^\]]*\]?$/iu.test(line)) continue;
    const withoutLinks = line.replace(/https?:\/\/\S+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (withoutLinks) content.push(withoutLinks);
    if (content.join(' ').length >= 1200) break;
  }
  return content.join(' ').slice(0, 1200);
}

function descriptionSimilarity(left, right) {
  const a = canonicalText(descriptionCore(left));
  const b = canonicalText(descriptionCore(right));
  if (!a || !b) return 0;
  if (a === b) return 1;
  const leftTokens = usefulTokens(a);
  const rightTokens = usefulTokens(b);
  if (Math.min(leftTokens.size, rightTokens.size) < 12) return 0;
  return jaccard(leftTokens, rightTokens);
}

function conflictRecord(kind, candidate, peer, score) {
  return {
    kind,
    videoId: String(peer.videoId || peer.id || ''),
    title: String(peer.title || '').slice(0, 160),
    similarity: Number(score.toFixed(3))
  };
}

function findMetadataConflicts({ title, description, videoId, peers = [] } = {}) {
  const conflicts = [];
  for (const peer of Array.isArray(peers) ? peers : []) {
    if (!peer || String(peer.videoId || peer.id || '') === String(videoId || '')) continue;
    const peerTitle = String(peer.title || '');
    const titleScore = titleSimilarity(title, peerTitle);
    if (titleScore === 1 || titleScore >= TITLE_DUPLICATE_THRESHOLD) {
      conflicts.push(conflictRecord('title', title, peer, titleScore));
    }
    const descriptionScore = descriptionSimilarity(description, peer.description);
    if (descriptionScore === 1 || descriptionScore >= 0.88) {
      conflicts.push(conflictRecord('description', description, peer, descriptionScore));
    }
  }
  return conflicts;
}

function fitTitleWithSuffix(title, suffix, maxLength) {
  const ending = ` | ${suffix}`;
  const base = String(title || '').trim();
  if (ending.length >= maxLength) return ending.slice(-maxLength).trim();
  return `${base.slice(0, maxLength - ending.length).trimEnd()}${ending}`;
}

function makeDistinctTitle(title, discriminator, seenTitles = [], maxLength = 100) {
  const clean = String(title || '').replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const limit = Number.isSafeInteger(maxLength) ? Math.max(24, Math.min(100, maxLength)) : 100;
  const candidate = clean.slice(0, limit).trim();
  const seen = (Array.isArray(seenTitles) ? seenTitles : []).map((value) =>
    typeof value === 'string' ? value : String(value?.title || '')).filter(Boolean);
  const sameTitle = (value) => canonicalText(candidate) === canonicalText(value);
  if (!seen.some(sameTitle)) return candidate;
  const detail = String(discriminator || '').replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!detail) throw new Error('A factual detail is required to distinguish a repeated title');
  let unique = fitTitleWithSuffix(candidate, detail, limit);
  for (let ordinal = 2; seen.some((value) => canonicalText(unique) === canonicalText(value)); ordinal += 1) {
    if (ordinal > 100) throw new Error('Could not distinguish a repeated video title');
    unique = fitTitleWithSuffix(candidate, `${detail} item ${ordinal}`, limit);
  }
  return unique;
}

module.exports = {
  canonicalText,
  titleSimilarity,
  descriptionCore,
  descriptionSimilarity,
  findMetadataConflicts,
  makeDistinctTitle
};
