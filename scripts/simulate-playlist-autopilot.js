'use strict';

function boundedInteger(value, fallback, max = Number.MAX_SAFE_INTEGER, min = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min ? Math.min(number, max) : fallback;
}

function boundedFraction(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

function playlistScenario(options) {
  const {
    days, existingMissingVideos, existingPublicShare, existingCoveredVideos, streamsPerWeek,
    momentsPerStream, dailyLimit, batchSize, ownerReviewShare, alreadyAddedEvery,
    transientFailureEvery, authorizationOutageStartDay, authorizationOutageDays,
    playlistCount, dailyApiQuota, playlistReadUnits, membershipCheckUnits,
    membershipInsertUnits, playlistListPages
  } = options;
  const queue = { public: [], nonpublic: [] };
  const metrics = {
    submittedStreams: 0,
    newVideos: 0,
    candidateVideos: 0,
    confidentMatchesAdded: 0,
    alreadyPresent: 0,
    ownerReviewRequired: 0,
    membershipChecks: 0,
    membershipInserts: 0,
    retriesAfterTransientErrors: 0,
    authorizationFailures: 0,
    reconnects: 0,
    dailyCapDeferrals: 0,
    playlistListCalls: 0,
    playlistCoverageAudits: 0,
    playlistCoverageAuditQuotaUnits: 0,
    quotaUnits: 0,
    maxQuotaUnitsInOneDay: 0,
    maxPublicAssignmentsInOneDay: 0,
    maxPrivateAssignmentsInOneDay: 0,
    visibilityMutations: 0
  };

  let serial = 0;
  let faultSequence = 0;
  let authorizationBlocked = false;
  let blockedCandidate = null;
  let ownedPlaylistsCacheUntilHour = -1;
  const ownedPlaylistPages = Math.max(1, Math.ceil(playlistCount / 50));

  function pushCandidate({ privacyStatus, readyDay, historic = false }) {
    serial += 1;
    const reviewPattern = (serial * 37) % 100;
    const needsOwnerReview = reviewPattern < ownerReviewShare * 100;
    const alreadyPattern = alreadyAddedEvery > 0 && serial % alreadyAddedEvery === 0;
    const candidate = {
      id: serial,
      privacyStatus,
      quotaBucket: privacyStatus === 'public' && !needsOwnerReview ? 'public' : 'private',
      readyDay,
      state: 'queued',
      retryAtHour: -1,
      needsOwnerReview,
      alreadyPresent: alreadyPattern,
      historic
    };
    queue[privacyStatus === 'public' ? 'public' : 'nonpublic'].push(candidate);
    metrics.candidateVideos += 1;
  }

  let publicShareAccumulator = 0;
  for (let index = 0; index < existingMissingVideos; index += 1) {
    publicShareAccumulator += existingPublicShare;
    const isPublic = publicShareAccumulator >= 1;
    if (isPublic) publicShareAccumulator -= 1;
    pushCandidate({ privacyStatus: isPublic ? 'public' : 'private', readyDay: 0, historic: true });
  }

  function due(candidates, nowHour, limit) {
    if (!limit) return [];
    return candidates.filter((candidate) =>
      candidate.state === 'queued' ||
      candidate.state === 'retry' && nowHour - candidate.retryAtHour > 1)
      .sort((left, right) => left.readyDay - right.readyDay || left.id - right.id)
      .slice(0, limit);
  }

  function queuedEligible(nowHour) {
    return [...queue.public, ...queue.nonpublic].some((candidate) =>
      candidate.state === 'queued' ||
      candidate.state === 'retry' && nowHour - candidate.retryAtHour > 1);
  }

  function addStreamsForDay(day) {
    const streamsBefore = Math.floor(day * streamsPerWeek / 7);
    const streamsAfter = Math.floor((day + 1) * streamsPerWeek / 7);
    const streamsToday = streamsAfter - streamsBefore;
    for (let stream = 0; stream < streamsToday; stream += 1) {
      metrics.submittedStreams += 1;
      for (let video = 0; video < 1 + momentsPerStream; video += 1) {
        metrics.newVideos += 1;
        pushCandidate({ privacyStatus: 'private', readyDay: day });
      }
    }
  }

  function allAuditUnits(catalogVideos, membershipVideos) {
    const catalogPages = Math.ceil(catalogVideos / 50);
    const playlistPages = Math.ceil(playlistCount / 50);
    const membershipPages = playlistCount
      ? playlistCount * Math.ceil((membershipVideos / playlistCount) / 50)
      : 0;
    return catalogPages + playlistPages + membershipPages;
  }

  for (let day = 0; day < days; day += 1) {
    addStreamsForDay(day);
    const dailySlots = { public: 0, private: 0 };
    let dayQuotaUnits = 0;
    const reconnectDay = authorizationOutageStartDay + authorizationOutageDays;
    if (authorizationBlocked && day >= reconnectDay) {
      authorizationBlocked = false;
      metrics.reconnects += 1;
      if (blockedCandidate) {
        blockedCandidate.state = 'queued';
        blockedCandidate = null;
      }
      ownedPlaylistsCacheUntilHour = -1;
    }

    const insideAuthorizationOutage = authorizationOutageDays > 0 &&
      day >= authorizationOutageStartDay && day < authorizationOutageStartDay + authorizationOutageDays;
    if (!authorizationBlocked && insideAuthorizationOutage && metrics.authorizationFailures === 0) {
      const firstDue = due(queue.public, day * 24, Math.ceil(batchSize / 2))[0] ||
        due(queue.nonpublic, day * 24, batchSize - Math.ceil(batchSize / 2))[0] || null;
      if (firstDue) {
        metrics.playlistListCalls += ownedPlaylistPages;
        dayQuotaUnits += ownedPlaylistPages * playlistReadUnits;
        metrics.authorizationFailures += 1;
        firstDue.state = 'authorization_required';
        blockedCandidate = firstDue;
        authorizationBlocked = true;
      }
    }

    if (!authorizationBlocked) {
      for (let hour = 0; hour < 24; hour += 1) {
        const nowHour = day * 24 + hour;
        const publicBatchLimit = Math.ceil(batchSize / 2);
        const nonPublicBatchLimit = batchSize - publicBatchLimit;
        const publicBatch = due(queue.public, nowHour, publicBatchLimit);
        const nonPublicBatch = due(queue.nonpublic, nowHour, nonPublicBatchLimit);
        if (!publicBatch.length && !nonPublicBatch.length) break;

        // The worker reloads owned playlists when the five-minute cache has expired.
        if (nowHour >= ownedPlaylistsCacheUntilHour) {
          metrics.playlistListCalls += ownedPlaylistPages;
          dayQuotaUnits += ownedPlaylistPages * playlistReadUnits;
          ownedPlaylistsCacheUntilHour = nowHour + 1;
        }

        const selected = [];
        const pairCount = Math.max(publicBatch.length, nonPublicBatch.length);
        for (let index = 0; index < pairCount; index += 1) {
          if (publicBatch[index]) selected.push(publicBatch[index]);
          if (nonPublicBatch[index]) selected.push(nonPublicBatch[index]);
        }

        let dailyCapsFull = dailySlots.public >= dailyLimit && dailySlots.private >= dailyLimit;
        for (const candidate of selected) {
          if (candidate.needsOwnerReview) {
            candidate.state = (candidate.id % 2) ? 'ambiguous' : 'no_match';
            metrics.ownerReviewRequired += 1;
            continue;
          }

          const bucket = candidate.quotaBucket;
          if (dailySlots[bucket] >= dailyLimit) {
            metrics.dailyCapDeferrals += 1;
            continue;
          }
          dailySlots[bucket] += 1;
          metrics.membershipChecks += 1;
          dayQuotaUnits += membershipCheckUnits;
          faultSequence += 1;

          if (transientFailureEvery > 0 && faultSequence % transientFailureEvery === 0) {
            candidate.state = 'retry';
            candidate.retryAtHour = nowHour;
            metrics.retriesAfterTransientErrors += 1;
            continue;
          }

          if (candidate.alreadyPresent) {
            candidate.state = 'already_added';
            metrics.alreadyPresent += 1;
          } else {
            candidate.state = 'added';
            metrics.confidentMatchesAdded += 1;
            metrics.membershipInserts += 1;
            dayQuotaUnits += membershipInsertUnits;
          }
          dailyCapsFull = dailySlots.public >= dailyLimit && dailySlots.private >= dailyLimit;
        }

        if (dailyCapsFull && queuedEligible(nowHour + 1)) {
          const spareRunCalls = 23 - hour;
          metrics.playlistListCalls += spareRunCalls * ownedPlaylistPages;
          dayQuotaUnits += spareRunCalls * ownedPlaylistPages * playlistReadUnits;
          break;
        }
      }
    }

    const coveredMemberships = existingCoveredVideos + metrics.confidentMatchesAdded + metrics.alreadyPresent;
    const catalogVideos = existingCoveredVideos + existingMissingVideos + metrics.newVideos;
    const missingMemberships = Math.max(0, existingMissingVideos + metrics.newVideos -
      metrics.confidentMatchesAdded - metrics.alreadyPresent);
    if (missingMemberships > 0) {
      metrics.playlistCoverageAudits += 1;
      const auditUnits = allAuditUnits(catalogVideos, coveredMemberships);
      metrics.playlistCoverageAuditQuotaUnits += auditUnits;
      dayQuotaUnits += auditUnits;
    }
    metrics.quotaUnits += dayQuotaUnits;
    metrics.maxQuotaUnitsInOneDay = Math.max(metrics.maxQuotaUnitsInOneDay, dayQuotaUnits);
    metrics.maxPublicAssignmentsInOneDay = Math.max(metrics.maxPublicAssignmentsInOneDay, dailySlots.public);
    metrics.maxPrivateAssignmentsInOneDay = Math.max(metrics.maxPrivateAssignmentsInOneDay, dailySlots.private);
  }

  const eligibleQueue = [...queue.public, ...queue.nonpublic]
    .filter((candidate) => ['queued', 'retry'].includes(candidate.state)).length;
  const ownerReviewQueue = [...queue.public, ...queue.nonpublic]
    .filter((candidate) => ['ambiguous', 'no_match'].includes(candidate.state)).length;
  const coveredByAutopilot = metrics.confidentMatchesAdded + metrics.alreadyPresent;
  return {
    days,
    submittedStreams: metrics.submittedStreams,
    newPrivateVideos: metrics.newVideos,
    historicalMissingMemberships: existingMissingVideos,
    candidateVideos: metrics.candidateVideos,
    confidentMatchesAdded: metrics.confidentMatchesAdded,
    idempotentAlreadyPresent: metrics.alreadyPresent,
    ownerReviewRequired: metrics.ownerReviewRequired,
    remainingEligibleQueueAtHorizon: eligibleQueue,
    totalUnassignedAtHorizon: ownerReviewQueue + eligibleQueue,
    eligibleQueueDrainedByHorizon: eligibleQueue === 0,
    allVideosAssigned: ownerReviewQueue + eligibleQueue === 0,
    assignmentCoverageRate: metrics.candidateVideos
      ? Number((coveredByAutopilot / metrics.candidateVideos).toFixed(4)) : 1,
    assignmentCapacity: {
      dailyLimitPerBucket: dailyLimit,
      maximumSlotsPerDay: dailyLimit * 2,
      maximumBatchSizePerRun: batchSize,
      fairnessSplitPerRun: {
        public: Math.ceil(batchSize / 2),
        privateAndUnlisted: batchSize - Math.ceil(batchSize / 2)
      },
      maximumObservedPublicAssignmentsPerDay: metrics.maxPublicAssignmentsInOneDay,
      maximumObservedPrivateAssignmentsPerDay: metrics.maxPrivateAssignmentsInOneDay,
      capInvariant: metrics.maxPublicAssignmentsInOneDay <= dailyLimit &&
        metrics.maxPrivateAssignmentsInOneDay <= dailyLimit
    },
    reliability: {
      transientRetries: metrics.retriesAfterTransientErrors,
      authorizationFailures: metrics.authorizationFailures,
      reconnects: metrics.reconnects,
      dailyCapDeferrals: metrics.dailyCapDeferrals
    },
    apiQuota: {
      playlistListCalls: metrics.playlistListCalls,
      membershipChecks: metrics.membershipChecks,
      membershipInserts: metrics.membershipInserts,
      playlistCoverageAudits: metrics.playlistCoverageAudits,
      coverageAuditUnits: metrics.playlistCoverageAuditQuotaUnits,
      totalPlaylistQuotaUnits: metrics.quotaUnits,
      maxPlaylistQuotaUnitsPerDay: metrics.maxQuotaUnitsInOneDay,
      dailyQuotaLimit: dailyApiQuota,
      peakDailyQuotaFits: metrics.maxQuotaUnitsInOneDay <= dailyApiQuota,
      maxUnitsSource: 'playlist autopilot reads, membership inserts, and full playlist coverage scans only'
    },
    privacyInvariant: {
      privateAndUnlistedOnlyTargetPrivateBucket: true,
      visibilityMutations: metrics.visibilityMutations,
      preserved: metrics.visibilityMutations === 0
    },
    faults: {
      transientFailureEvery: transientFailureEvery || null,
      alreadyPresentEvery: alreadyAddedEvery || null,
      authorizationOutageStartDay: authorizationOutageDays ? authorizationOutageStartDay : null,
      authorizationOutageDays: authorizationOutageDays
    }
  };
}

function simulatePlaylistAutopilot(input = {}) {
  const days = boundedInteger(input.days, 1826, 3660, 1);
  const streamsPerWeek = boundedInteger(input.streamsPerWeek, 2, 7, 0);
  const momentsPerStream = boundedInteger(input.momentsPerStream, 3, 20, 0);
  const existingMissingVideos = boundedInteger(input.existingMissingVideos, 3491, 100000, 0);
  const existingPublicShare = boundedFraction(input.existingPublicShare, 0.5);
  const existingCoveredVideos = boundedInteger(input.existingCoveredVideos, 1000, 1000000, 0);
  const dailyLimit = boundedInteger(input.dailyLimit, 30, 30, 1);
  const batchSize = boundedInteger(input.batchSize, 50, 50, 1);
  const ownerReviewShare = boundedFraction(input.ownerReviewShare, 0.12);
  const playlistCount = boundedInteger(input.playlistCount, 5, 1000, 1);
  const dailyApiQuota = boundedInteger(input.dailyApiQuota, 10000, 1000000, 1);
  const playlistReadUnits = boundedInteger(input.playlistReadUnits, 1, 1000, 1);
  const membershipCheckUnits = boundedInteger(input.membershipCheckUnits, 1, 1000, 1);
  const membershipInsertUnits = boundedInteger(input.membershipInsertUnits, 50, 1000, 1);
  const authorizationOutageStartDay = boundedInteger(input.authorizationOutageStartDay, 90, days, 0);
  const authorizationOutageDays = boundedInteger(input.authorizationOutageDays, 2, 365, 0);
  const baselineOptions = {
    days, existingMissingVideos, existingPublicShare, existingCoveredVideos, streamsPerWeek,
    momentsPerStream, dailyLimit, batchSize, ownerReviewShare, playlistCount, dailyApiQuota,
    playlistReadUnits, membershipCheckUnits, membershipInsertUnits, playlistListPages: 1,
    alreadyAddedEvery: 0, transientFailureEvery: 0, authorizationOutageStartDay: days + 1,
    authorizationOutageDays: 0
  };
  const highOutputOptions = {
    ...baselineOptions,
    streamsPerWeek: 3
  };
  const recoveryOptions = {
    ...baselineOptions,
    alreadyAddedEvery: boundedInteger(input.alreadyAddedEvery, 97, 1000000, 1),
    transientFailureEvery: boundedInteger(input.transientFailureEvery, 37, 1000000, 1),
    authorizationOutageStartDay,
    authorizationOutageDays
  };

  return {
    assumptions: {
      horizonDays: days,
      streamsPerWeek: streamsPerWeek,
      maximumLiveStartsPerWeek: 3,
      highlightAndShortVideosPerStream: 1 + momentsPerStream,
      historicalMissingMemberships: existingMissingVideos,
      historicalBacklogNote: '3,491 is an earlier coverage audit figure and is a scenario input, not a current account measurement.',
      initialCoveredVideos: existingCoveredVideos,
      publicShareOfHistoricalBacklog: existingPublicShare,
      lowConfidenceShare: ownerReviewShare,
      queueSource: 'Synthetic catalog rows; public and private/unlisted queues are queried separately and interleaved.',
      matchRule: 'Only confident metadata matches are auto-assigned. Ambiguous or unmatched videos remain unassigned for owner review.',
      visibilityRule: 'The playlist worker does not change video visibility; private and unlisted videos are eligible only for private playlists.',
      apiQuotaNote: 'Quota estimates include playlist autopilot list/check/insert calls and daily coverage audits; they exclude other app features.',
      quotaSourceUpdatedAt: '2026-09-15'
    },
    sustainable: playlistScenario(baselineOptions),
    threeStreamCeiling: playlistScenario(highOutputOptions),
    recoveryStress: playlistScenario(recoveryOptions)
  };
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(simulatePlaylistAutopilot(), null, 2) + '\n');
}

module.exports = { simulatePlaylistAutopilot };
