'use strict';

const { rateThumbnailBriefs } = require('../src/thumbnail-rating');

const DAY_MS = 24 * 60 * 60 * 1000;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function dateOnly(value) {
  const parsed = new Date(String(value || ''));
  if (Number.isNaN(parsed.getTime())) throw new Error('startDate must be an ISO date');
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function candidatePackage(id) {
  const source = {
    title: 'ARC Raiders floating raider encounter ' + id,
    description: 'ARC Raiders gameplay near the Seed Vault. A floating raider appears during the extraction fight.',
    tags: ['ARC Raiders', 'Seed Vault', 'floating raider', 'gameplay']
  };
  return {
    source,
    context: { takeaways: '' },
    analysis: { summary: 'The raider floats near the Seed Vault during extraction.',
      visualContext: 'Gameplay shows the floating raider at the Seed Vault.',
      topics: ['ARC Raiders', 'Seed Vault'], keywords: ['floating raider', 'extraction'] },
    briefs: [
      { overlay: 'FLOATING RAIDER', visual: 'Gameplay image of the floating raider',
        palette: 'Amber and cyan', hook: 'Unexpected movement during extraction' },
      { overlay: 'SEED VAULT', visual: 'Seed Vault extraction scene',
        palette: 'Bright amber against dark blue', hook: 'The fight reaches the Seed Vault' },
      { overlay: 'RAREST BLUEPRINT', visual: 'Blueprint close-up',
        palette: 'Gold and black', hook: 'The rarest blueprint appears' }
    ]
  };
}

function simulateTwoYears(input = {}) {
  const start = dateOnly(input.startDate || '2026-10-04');
  const days = positiveInteger(input.days, 730);
  const initialPublicBacklog = positiveInteger(input.initialPublicBacklog, 1000);
  const newPublicVideosPerDay = Number.isSafeInteger(Number(input.newPublicVideosPerDay)) &&
    Number(input.newPublicVideosPerDay) >= 0 ? Number(input.newPublicVideosPerDay) : 1;
  const dailyLimit = positiveInteger(input.dailyLimit, 50);
  const privateVideos = Number.isSafeInteger(Number(input.privateVideos)) && Number(input.privateVideos) >= 0
    ? Number(input.privateVideos) : 20;
  const unlistedVideos = Number.isSafeInteger(Number(input.unlistedVideos)) && Number(input.unlistedVideos) >= 0
    ? Number(input.unlistedVideos) : 20;
  const rateLimitEvery = positiveInteger(input.rateLimitEvery, 37);
  const end = new Date(start.getTime() + (days - 1) * DAY_MS);
  const queue = [];
  for (let index = 1; index <= initialPublicBacklog; index += 1) {
    queue.push({ id: index, initial: true, readyDay: 0, selection: null, attempts: 0 });
  }

  const metrics = {
    processedPublicVideos: 0,
    ratedCandidates: 0,
    eligibleCandidates: 0,
    rejectedCandidates: 0,
    selectedVideos: 0,
    noRecommendationVideos: 0,
    retriesAfterSimulatedRateLimit: 0,
    daysToClearInitialPublicBacklog: null,
    selectedOptionCounts: {},
    scoreTotal: 0,
    remainingEligibleQueueAtHorizon: 0
  };

  let nextId = initialPublicBacklog;
  let initialRemaining = initialPublicBacklog;
  let attempts = 0;
  for (let day = 0; day < days; day += 1) {
    for (let count = 0; count < newPublicVideosPerDay; count += 1) {
      nextId += 1;
      queue.push({ id: nextId, initial: false, readyDay: day, selection: null, attempts: 0 });
    }

    let capacity = dailyLimit;
    while (capacity > 0) {
      queue.sort((left, right) => left.readyDay - right.readyDay || left.id - right.id);
      const index = queue.findIndex((job) => job.readyDay <= day);
      if (index < 0) break;
      const [job] = queue.splice(index, 1);
      capacity -= 1;
      attempts += 1;
      job.attempts += 1;

      if (!job.selection) {
        const data = candidatePackage(job.id);
        const result = rateThumbnailBriefs(data.briefs, {
          source: data.source, context: data.context, analysis: data.analysis
        });
        job.selection = result.selected;
        metrics.ratedCandidates += result.ratings.length;
        metrics.eligibleCandidates += result.ratings.filter((rating) => rating.eligible).length;
        metrics.rejectedCandidates += result.ratings.filter((rating) => !rating.eligible).length;
        if (job.selection) {
          metrics.selectedVideos += 1;
          metrics.scoreTotal += job.selection.score;
          const option = String(job.selection.index + 1);
          metrics.selectedOptionCounts[option] = (metrics.selectedOptionCounts[option] || 0) + 1;
        } else {
          metrics.noRecommendationVideos += 1;
        }
      }

      if (rateLimitEvery && job.id % rateLimitEvery === 0 && job.attempts === 1) {
        metrics.retriesAfterSimulatedRateLimit += 1;
        job.readyDay = day + 1;
        queue.push(job);
        continue;
      }

      metrics.processedPublicVideos += 1;
      if (job.initial) initialRemaining -= 1;
    }

    if (initialRemaining === 0 && metrics.daysToClearInitialPublicBacklog === null) {
      metrics.daysToClearInitialPublicBacklog = day + 1;
    }
  }

  metrics.remainingEligibleQueueAtHorizon = queue.length;
  const eligibleAdded = initialPublicBacklog + newPublicVideosPerDay * days;
  const peakDailyVideoLimit = dailyLimit;
  const dailyMaxApiUnits = dailyLimit * 100;
  return {
    title: 'Two-year thumbnail selection capacity simulation',
    note: 'Synthetic workflow load test only. Ratings rank text concepts by evidence and readability; the model does not predict CTR, watch time, views, or revenue and does not evaluate thumbnail pixels.',
    assumptions: {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      days,
      initialPublicBacklog,
      newPublicVideosPerDay,
      dailyLimit,
      candidatesPerVideo: 3,
      privateVideosExcluded: privateVideos,
      unlistedVideosExcluded: unlistedVideos,
      simulatedThumbnailRateLimitEvery: rateLimitEvery,
      estimatedYouTubeWriteCallsPerSelectedVideo: 2,
      estimatedDailyQuotaUnitsAtLimit: dailyMaxApiUnits
    },
    outcome: {
      eligiblePublicVideosAdded: eligibleAdded,
      ...metrics,
      selectedVideoShare: metrics.processedPublicVideos
        ? Number((metrics.selectedVideos / metrics.processedPublicVideos).toFixed(4)) : 0,
      averageSelectedHeuristicScore: metrics.selectedVideos
        ? Number((metrics.scoreTotal / metrics.selectedVideos).toFixed(1)) : null,
      estimatedYouTubeWriteCalls: metrics.processedPublicVideos * 2,
      initialBacklogClearedWithinHorizon: initialRemaining === 0,
      privacyInvariant: true,
      privateOrUnlistedWrites: 0
    }
  };
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(simulateTwoYears(), null, 2) + '\n');
}

module.exports = { simulateTwoYears };

