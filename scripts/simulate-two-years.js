'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const MARKET_AS_OF = '2026-10-06';
const MARKET_EVENTS = [
  {
    id: 'frozen-trail-free-play',
    title: 'Frozen Trail update and free-play window',
    startDate: '2026-10-08',
    endDate: '2026-10-12',
    source: 'https://arcraiders.com/news/play-for-free-weekend'
  },
  {
    id: 'pve-toggle-test',
    title: 'ARC Raiders PvE matchmaking toggle test',
    startDate: '2026-10-13',
    endDate: '2026-10-20',
    source: 'https://arcraiders.com/de/news/pve-toggle-beta-test'
  }
];

function positiveInteger(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : fallback;
}

function dateOnly(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('startDate must be an ISO date');
  const parsed = new Date(text + 'T00:00:00.000Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error('startDate must be a valid ISO date');
  }
  return parsed;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function makeHorizon(input) {
  const start = dateOnly(input.startDate || MARKET_AS_OF);
  const years = positiveInteger(input.years, 2);
  const endExclusive = new Date(start);
  endExclusive.setUTCFullYear(endExclusive.getUTCFullYear() + years);
  const days = Math.round((endExclusive.getTime() - start.getTime()) / DAY_MS);
  return {
    start,
    endExclusive,
    startDate: isoDate(start),
    endExclusiveDate: isoDate(endExclusive),
    lastIncludedDate: isoDate(addDays(endExclusive, -1)),
    days,
    weeks: Math.ceil(days / 7),
    years
  };
}

function marketEventForTargetDate(targetDate) {
  const date = isoDate(targetDate);
  return MARKET_EVENTS.find((event) => date >= event.startDate && date <= event.endDate) || null;
}

function createJob(id, scheduledDay, shorts, start) {
  const outputs = [{ id: id + '-highlight', kind: 'highlight' }];
  for (let index = 1; index <= shorts; index += 1) {
    outputs.push({ id: id + '-short-' + index, kind: 'short' });
  }
  for (const output of outputs) {
    output.privacyStatus = 'private';
    output.uploadStatus = 'processed';
    output.processingStatus = 'succeeded';
  }
  const targetPublishDate = addDays(addDays(start, scheduledDay), 2);
  return {
    id,
    scheduledDay,
    targetPublishDate,
    shorts,
    outputs,
    marketEvent: marketEventForTargetDate(targetPublishDate),
    status: 'queued',
    readyDay: scheduledDay,
    attempts: 0,
    seenFaults: new Set()
  };
}

function weeklyJobs(horizon, start, options) {
  const jobs = [];
  let id = 0;
  for (let week = 0; week < horizon.weeks; week += 1) {
    if (week % options.everyWeeks !== 0) continue;
    for (const slot of options.daysInWeek) {
      const day = week * 7 + slot;
      if (day >= horizon.days) continue;
      id += 1;
      jobs.push(createJob(id, day, options.shortsFor(week, slot), start));
    }
  }
  return jobs;
}

function selectedVodsPerWeekJobs(horizon, start) {
  const jobs = [];
  let id = 0;
  for (let week = 0; week < horizon.weeks; week += 1) {
    // 6, 6, 6, 5 sessions per four weeks is close to 150 streaming
    // hours/month when each selected VOD is about six hours.
    const sessions = week % 4 === 3 ? 5 : 6;
    for (let session = 0; session < sessions; session += 1) {
      const day = week * 7 + session;
      if (day >= horizon.days) continue;
      id += 1;
      jobs.push(createJob(id, day, 3, start));
    }
  }
  return jobs;
}

function every(id, period) {
  return period > 0 && id % period === 0;
}

function isFinishedVideo(output) {
  return output.uploadStatus === 'processed' &&
    output.processingStatus === 'succeeded';
}

function allOutputsFinished(job) {
  return job.outputs.length > 0 && job.outputs.every(isFinishedVideo);
}

function summarizeMarketCoverage(jobs) {
  return MARKET_EVENTS.map((event) => ({
    event: event.title,
    startDate: event.startDate,
    endDate: event.endDate,
    source: event.source,
    candidatePackagesInWindow: jobs.filter((job) => job.marketEvent?.id === event.id).length
  }));
}

function runScenario({ name, description, horizon, start, jobs, attemptsPerDay, weeklyPlanUploadCapacity = null, faults = {} }) {
  const maxAttempts = positiveInteger(faults.maxAttempts, 12);
  const faultIntervals = {
    processingPendingEvery: positiveInteger(faults.processingPendingEvery, 0, 0),
    unknownProcessingStateEvery: positiveInteger(faults.unknownProcessingStateEvery, 0, 0),
    transientApiErrorEvery: positiveInteger(faults.transientApiErrorEvery, 0, 0),
    terminalProcessingFailureEvery: positiveInteger(faults.terminalProcessingFailureEvery, 0, 0)
  };
  const queue = [...jobs];
  const metrics = {
    plannedBatches: jobs.length,
    plannedHighlights: jobs.length,
    plannedShorts: jobs.reduce((total, job) => total + job.shorts, 0),
    plannedPrivateUploads: jobs.reduce((total, job) => total + job.outputs.length, 0),
    workerAttempts: 0,
    automaticRetries: 0,
    processingPendingChecks: 0,
    unknownProcessingStateChecks: 0,
    transientApiFailures: 0,
    terminalProcessingFailures: 0,
    completedBatches: 0,
    readyForOwnerReviewUploads: 0,
    batchesNeedingManualRecovery: 0,
    queuedAtHorizon: 0,
    publicUploads: 0,
    visibilityMutations: 0
  };

  function attempt(job) {
    job.attempts += 1;
    metrics.workerAttempts += 1;

    if (every(job.id, faultIntervals.terminalProcessingFailureEvery) &&
        !job.seenFaults.has('terminalProcessingFailure')) {
      job.seenFaults.add('terminalProcessingFailure');
      const failedOutput = job.outputs[job.outputs.length - 1];
      failedOutput.uploadStatus = 'failed';
      failedOutput.processingStatus = 'failed';
      metrics.terminalProcessingFailures += 1;
      return { manualRecovery: true };
    }

    if (every(job.id, faultIntervals.processingPendingEvery) &&
        !job.seenFaults.has('processingPending')) {
      job.seenFaults.add('processingPending');
      const pendingOutput = job.outputs[job.outputs.length - 1];
      pendingOutput.uploadStatus = 'uploaded';
      pendingOutput.processingStatus = 'processing';
      metrics.processingPendingChecks += 1;
      if (!allOutputsFinished(job)) return { retry: true };
    }

    if (every(job.id, faultIntervals.unknownProcessingStateEvery) &&
        !job.seenFaults.has('unknownProcessingState')) {
      job.seenFaults.add('unknownProcessingState');
      const unknownOutput = job.outputs[job.outputs.length - 1];
      unknownOutput.uploadStatus = 'processed';
      unknownOutput.processingStatus = 'unknown';
      metrics.unknownProcessingStateChecks += 1;
      if (!allOutputsFinished(job)) return { retry: true };
    }

    if (every(job.id, faultIntervals.transientApiErrorEvery) &&
        !job.seenFaults.has('transientApiError')) {
      job.seenFaults.add('transientApiError');
      metrics.transientApiFailures += 1;
      return { retry: true };
    }

    for (const output of job.outputs) {
      output.uploadStatus = 'processed';
      output.processingStatus = 'succeeded';
    }
    if (!allOutputsFinished(job)) return { retry: true };
    return { success: true };
  }

  for (let day = 0; day < horizon.days; day += 1) {
    let capacity = attemptsPerDay;
    while (capacity > 0) {
      queue.sort((left, right) => left.readyDay - right.readyDay || left.id - right.id);
      const index = queue.findIndex((job) => job.readyDay <= day);
      if (index < 0) break;
      const [job] = queue.splice(index, 1);
      capacity -= 1;
      const result = attempt(job);
      if (result.success) {
        job.status = 'awaiting_owner_approval';
        metrics.completedBatches += 1;
        metrics.readyForOwnerReviewUploads += job.outputs.length;
      } else if (result.manualRecovery) {
        job.status = 'manual_recovery';
        metrics.batchesNeedingManualRecovery += 1;
      } else if (result.retry && job.attempts < maxAttempts) {
        job.readyDay = day + 1;
        queue.push(job);
        metrics.automaticRetries += 1;
      } else {
        job.status = 'manual_recovery';
        metrics.batchesNeedingManualRecovery += 1;
      }
    }
  }

  metrics.queuedAtHorizon = queue.length;
  const plannedReviewCadenceUploads = Number.isSafeInteger(weeklyPlanUploadCapacity)
    ? Math.max(0, weeklyPlanUploadCapacity) : metrics.plannedPrivateUploads;
  const reviewQueueBeyondWeeklyPlan = Math.max(
    0, metrics.readyForOwnerReviewUploads - plannedReviewCadenceUploads
  );
  return {
    name,
    description,
    assumptions: {
      workerAttemptsPerDay: attemptsPerDay,
      maxAttemptsPerBatch: maxAttempts,
      faultIntervals,
      faultRatesAreMeasuredProductionData: false
    },
    outcome: {
      ...metrics,
      finishedPrivateUploads: metrics.readyForOwnerReviewUploads,
      unfinishedOrFailedBundleCount: jobs.length - metrics.completedBatches,
      reviewQueueBeyondWeeklyPlan,
      weeklyReviewCapacityUploads: plannedReviewCadenceUploads,
      allReadyOutputsRemainPrivate: true,
      ownerApprovalRequired: true,
      automaticPublicationAttempts: 0,
      existingVisibilityMutations: 0,
      privacyInvariant: metrics.publicUploads === 0 && metrics.visibilityMutations === 0
    },
    marketCoverage: summarizeMarketCoverage(jobs)
  };
}

function lowViewPriorityPreview() {
  const sampleCandidates = [
    { videoId: 'sample-1400-views', viewCount: '1400', status: 'ready', missingEvidenceCount: 0 },
    { videoId: 'sample-12-views', viewCount: '12', status: 'ready', missingEvidenceCount: 0 },
    { videoId: 'sample-unknown-views', viewCount: null, status: 'ready', missingEvidenceCount: 0 },
    { videoId: 'sample-84-views', viewCount: '84', status: 'ready', missingEvidenceCount: 0 }
  ];
  const { prioritizeSeoAutoCandidates } = require('../src/seo-priority');
  return {
    dataType: 'synthetic ordering fixture; no @saevond analytics are included',
    priorityOrder: prioritizeSeoAutoCandidates(sampleCandidates, sampleCandidates.length)
      .map((candidate) => candidate.videoId),
    lowViewFirst: true
  };
}

function simulateTwoYears(input = {}) {
  const horizon = makeHorizon(input);
  const start = horizon.start;
  const baseOptions = {
    everyWeeks: 1,
    daysInWeek: [0],
    shortsFor: (week) => 3 + (week % 2)
  };
  const plannedJobs = weeklyJobs(horizon, start, baseOptions);
  const lowCadenceJobs = weeklyJobs(horizon, start, {
    everyWeeks: 2,
    daysInWeek: [0],
    shortsFor: () => 3
  });
  const fullStreamJobs = selectedVodsPerWeekJobs(horizon, start);
  const plannedUploads = plannedJobs.reduce((total, job) => total + job.outputs.length, 0);

  const scenarios = {
    lowCadence: runScenario({
      name: 'Lower cadence',
      description: 'One selected VOD every two weeks; one highlight and three Shorts per batch.',
      horizon, start, jobs: lowCadenceJobs, attemptsPerDay: 4, weeklyPlanUploadCapacity: plannedUploads
    }),
    plannedCadence: runScenario({
      name: 'Planned creator cadence',
      description: 'One selected VOD each week; one highlight and alternating three/four Shorts.',
      horizon, start, jobs: plannedJobs, attemptsPerDay: 4, weeklyPlanUploadCapacity: plannedUploads
    }),
    recoveryStress: runScenario({
      name: 'Planned cadence with recovery faults',
      description: 'Planned cadence plus deterministic pending-processing, unknown-status, transient-API, and terminal-processing cases.',
      horizon, start, jobs: plannedJobs.map((job) => ({
        ...job, outputs: job.outputs.map((output) => ({ ...output })),
        seenFaults: new Set()
      })), attemptsPerDay: 4, weeklyPlanUploadCapacity: plannedUploads,
      faults: {
        processingPendingEvery: 17,
        unknownProcessingStateEvery: 47,
        transientApiErrorEvery: 23,
        terminalProcessingFailureEvery: 101,
        maxAttempts: 12
      }
    }),
    fullStreamIngest: runScenario({
      name: 'All-session VOD intake',
      description: 'About five or six selected six-hour VODs per week, matching roughly 150 stream hours/month; three Shorts are produced for each VOD.',
      horizon, start, jobs: fullStreamJobs, attemptsPerDay: 4, weeklyPlanUploadCapacity: plannedUploads
    })
  };

  const allMarketWindows = summarizeMarketCoverage(plannedJobs);
  return {
    title: 'AmaanaYT two-year finished-video and review-queue simulation',
    note: 'Operational capacity and recovery simulation only. It does not forecast views, click-through rate, Google placement, watch time, subscribers, or revenue. Synthetic faults are test injections, not measured production rates.',
    horizon: {
      startDate: horizon.startDate,
      endDateExclusive: horizon.endExclusiveDate,
      lastIncludedDate: horizon.lastIncludedDate,
      calendarYears: horizon.years,
      days: horizon.days,
      scheduledWeeks: horizon.weeks
    },
    operatingAssumptions: {
      streamingHoursPerMonth: 150,
      approximateSessionLengthHours: 6,
      expectedLiveSessionsPerWeek: 'about 5 to 6',
      ownerReviewPublishingCadence: {
        highlightsPerWeek: 1,
        shortsPerWeek: '3 to 4'
      },
      selectedVodsPerWeekScenario: 'one package per week',
      outputProcessingGate: [
        'render, duration, and aspect-ratio checks pass',
        'timestamp and source-clip checks pass',
        'thumbnail and SEO registration pass',
        'every YouTube output has uploadStatus=processed and processingStatus=succeeded'
      ],
      newVideosStayPrivateUntilOwnerApproval: true,
      lowViewVideosRemainFirstPriority: true
    },
    currentMarketResearch: {
      asOf: MARKET_AS_OF,
      currentTopicEvents: MARKET_EVENTS,
      publisherReportedArcRaidersAudienceSignals: {
        friendlyCoopPercent: 37,
        mixedPlayPercent: 27,
        purePvpPercent: 34,
        reportedInterestInDedicatedPvePercent: 51,
        source: 'https://arcraiders.com/de/news/pve-toggle-beta-test',
        use: 'Topic coverage only; not a search-volume or view-uplift multiplier.'
      },
      youtubeGuidance: {
        tags: 'YouTube says tags play a minimal discovery role except for common misspellings.',
        performance: 'Measure viewer choice, viewing, and satisfaction with channel data.',
        viewMetricChangeDate: '2026-08-24',
        viewMetricCaveat: 'Public views count video starts across formats; use Engaged Views and matching-format analytics when judging whether people continued watching.',
        ctrBenchmark: 'No universal good CTR benchmark; compare like formats against the channel’s own history.',
        noPredictedViewLift: true
      },
      marketWindowCoverageFromPlannedCadence: allMarketWindows
    },
    lowViewPriorityPreview: lowViewPriorityPreview(),
    scenarios
  };
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(simulateTwoYears(), null, 2) + '\n');
}

module.exports = { simulateTwoYears, runScenario, weeklyJobs, selectedVodsPerWeekJobs };
