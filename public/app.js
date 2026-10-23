const loginView = document.querySelector('#loginView');
const dashboardView = document.querySelector('#dashboardView');
const loginForm = document.querySelector('#loginForm');
const uploadForm = document.querySelector('#uploadForm');
const playlistList = document.querySelector('#playlistList');
const playlistForm = document.querySelector('#playlistForm');
const playlistCreateButton = document.querySelector('#playlistCreateButton');
const notice = document.querySelector('#notice');
const vodScanForm = document.querySelector('#vodScanForm');
const vodScanStatus = document.querySelector('#vodScanStatus');
const connectionDot = document.querySelector('#connectionDot');
const connectionText = document.querySelector('#connectionText');
const connectionHelp = document.querySelector('#connectionHelp');
const connectButton = document.querySelector('#connectButton');
const twitchConnectionDot = document.querySelector('#twitchConnectionDot');
const twitchConnectionText = document.querySelector('#twitchConnectionText');
const twitchConnectionHelp = document.querySelector('#twitchConnectionHelp');
const twitchConnectButton = document.querySelector('#twitchConnectButton');
const tiktokConnectionDot = document.querySelector('#tiktokConnectionDot');
const tiktokConnectionText = document.querySelector('#tiktokConnectionText');
const tiktokConnectionHelp = document.querySelector('#tiktokConnectionHelp');
const tiktokConnectButton = document.querySelector('#tiktokConnectButton');
const draftList = document.querySelector('#draftList');
const uploadButton = document.querySelector('#uploadButton');
const seoList = document.querySelector('#seoList');
const seoStatus = document.querySelector('#seoStatus');
const seoToggle = document.querySelector('#seoToggle');
const seoPrevious = document.querySelector('#seoPrevious');
const seoNext = document.querySelector('#seoNext');
const seoPlaylistAudit = document.querySelector('#seoPlaylistAudit');
const seoPlaylistAuditStatus = document.querySelector('#seoPlaylistAuditStatus');
const seoPage = document.querySelector('#seoPage');
const seoChannel = document.querySelector('#seoChannel');
const channelJaForm = document.querySelector('#channelJaForm');
const channelJaTitle = document.querySelector('#channelJaTitle');
const channelJaDescription = document.querySelector('#channelJaDescription');
const channelJaStatus = document.querySelector('#channelJaStatus');
const jaAutopilotToggle = document.querySelector('#jaAutopilotToggle');
const jaAutopilotStatus = document.querySelector('#jaAutopilotStatus');
const googleSearchImportForm = document.querySelector('#googleSearchImportForm');
const googleSearchImportStatus = document.querySelector('#googleSearchImportStatus');
let seoOffset = 0;
let seoEnabled = true;
let draftPoll = null;
let tiktokConnected = false;
let youtubePlaylists = [];
let channelLocalizationSnapshot = null;
let japaneseAutopilotState = null;
let japaneseAutopilotPoll = null;
let japaneseAutopilotLoading = false;
let japaneseAutopilotKnownTotalUpdated = null;

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.remove('hidden', 'error');
  if (isError) notice.classList.add('error');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearNotice() {
  notice.textContent = '';
  notice.classList.add('hidden');
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof data === 'object' ? data.error : data;
    const error = new Error(message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showLogin() {
  if (draftPoll) clearInterval(draftPoll);
  draftPoll = null;
  loginView.classList.remove('hidden');
  dashboardView.classList.add('hidden');
}

function showDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  refreshDashboard();
  if (!japaneseAutopilotPoll) japaneseAutopilotPoll = setInterval(() => {
    if (!document.hidden && !dashboardView.classList.contains('hidden')) loadJapaneseAutopilotStatus();
  }, 15000);
  if (!draftPoll) draftPoll = setInterval(() => {
    if (!document.hidden) loadDrafts();
  }, 12000);
}

async function refreshConnection() {
  const status = await api('/api/youtube/status');
  const analyticsNeedsReconnect = status.analyticsNeedsReconnect === true;
  const analyticsNeedsConsent = status.connected && status.analyticsReadAccess !== true;
  connectionDot.classList.toggle('connected', status.connected && !analyticsNeedsReconnect);
  connectionText.textContent = analyticsNeedsReconnect ? 'Reconnect required'
    : status.connected ? 'Connected' : 'Not connected';
  const accountHelp = !status.connected ? 'Connect the Google account that owns @saevond.'
    : status.canApprove
      ? 'Amaana can upload private drafts. You can approve publishing if Google permits it for this API project.'
      : 'Private uploads work. Reconnect YouTube to grant permission for owner approval and scheduling.';
  const analyticsHelp = analyticsNeedsReconnect
    ? 'Google rejected the saved YouTube token. Reconnect once; the low-view-first Analytics batch will resume after consent.'
    : analyticsNeedsConsent
      ? 'Reconnect once and grant youtube.readonly plus yt-analytics.readonly to start the daily low-view-first Analytics collection.'
      : status.analyticsReadAccess
        ? 'Daily read-only YouTube Analytics collection is authorized.' : '';
  connectionHelp.textContent = [accountHelp, analyticsHelp].filter(Boolean).join(' ');
  connectButton.textContent = status.connected ? 'Reconnect YouTube' : 'Connect YouTube';
}

async function refreshTwitchConnection() {
  const status = await api('/api/twitch/status');
  const highlightStatus = await api('/api/twitch/highlight-discovery/status').catch(() => null);
  twitchConnectionDot.classList.toggle('connected', status.connected);
  twitchConnectionText.textContent = status.connected
    ? `Connected as ${status.displayName || status.login || 'Twitch user'}`
    : 'Not connected';
  if (!status.configured) {
    twitchConnectionHelp.textContent = 'Add the Twitch Client ID and Client Secret in Render first.';
    twitchConnectButton.disabled = true;
    twitchConnectButton.textContent = 'Setup required';
  } else {
    twitchConnectionHelp.textContent = status.connected && highlightStatus && !highlightStatus.visualGameplayVerificationConfigured
      ? 'Visual gameplay screening is off. Amaana holds edits until ENABLE_GAMEPLAY_SCREENING and VIDEO_ANALYSIS_API_KEY are configured.'
      : status.connected
        ? 'While you are live, Amaana captures a 60-second segment every 3 minutes and checks for real gameplay. Every five verified captures (about 15 minutes of stream), it uploads a private Short for review. After collecting 12 minutes of verified gameplay footage, it also uploads the 12-minute highlight. Approve each video before it goes public.'
        : (status.error || 'Connect the Twitch account that owns the Saevond channel.');
    twitchConnectButton.disabled = false;
    twitchConnectButton.textContent = status.connected ? 'Reconnect Twitch' : 'Connect Twitch';
  }
}

async function refreshTikTokConnection() {
  const status = await api('/api/tiktok/status');
  tiktokConnected = status.connected;
  tiktokConnectionDot.classList.toggle('connected', status.connected);
  tiktokConnectionText.textContent = status.connected
    ? `Connected as ${status.displayName || 'TikTok creator'}` : 'Not connected';
  tiktokConnectButton.disabled = !status.configured;
  tiktokConnectButton.textContent = !status.configured ? 'Setup required'
    : status.connected ? 'Reconnect TikTok' : 'Connect TikTok';
  tiktokConnectionHelp.textContent = !status.configured
    ? 'Add a TikTok developer app key and secret in Render, and approve video.upload.'
    : status.connected
      ? 'Review each Short and enable automatic TikTok delivery. Amaana sends it after its public YouTube video exceeds 2,000 views; finish posting in your TikTok inbox.'
      : status.error || 'Connect your TikTok account to send reviewed Shorts to its inbox.';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function approveDraft(id, publishAt, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = publishAt ? 'Scheduling…' : 'Publishing…';
  try {
    await api(`/api/drafts/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publishAt: publishAt || null })
    });
    showNotice(publishAt ? 'Short scheduled successfully.' : 'Short published successfully.');
    await loadDrafts();
  } catch (error) {
    showNotice(error.message, true);
    button.disabled = false;
    button.textContent = original;
  }
}

function renderPlaylistAdder(videoId, videoPrivacyStatus = 'private') {
  if (!videoId) return null;
  const eligible = youtubePlaylists.filter((playlist) =>
    videoPrivacyStatus === 'public' || playlist.privacyStatus === 'private');
  const box = element('div', 'playlist-adder');
  const label = element('label', '', 'Add video to a playlist');
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Choose a YouTube playlist');
  const prompt = document.createElement('option');
  prompt.value = '';
  prompt.textContent = 'Choose a playlist';
  select.append(prompt);
  eligible.forEach((playlist) => {
    const option = document.createElement('option');
    option.value = playlist.id;
    option.textContent = playlist.title + ' · ' + playlist.privacyStatus;
    select.append(option);
  });
  const add = element('button', 'ghost', 'Add to playlist');
  add.type = 'button';
  add.disabled = eligible.length === 0;
  select.addEventListener('change', () => { add.disabled = !select.value; });
  add.addEventListener('click', async () => {
    if (!select.value) return;
    add.disabled = true;
    try {
      const result = await api('/api/youtube/playlists/' + encodeURIComponent(select.value) + '/items', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId })
      });
      showNotice(result.alreadyAdded ? 'Video is already in ' + result.playlist.title + '.'
        : 'Video added to ' + result.playlist.title + '. Its visibility was not changed.');
      await Promise.all([loadDrafts(), loadSeo()]);
    } catch (error) {
      showNotice(error.message, true);
      add.disabled = !select.value;
    }
  });
  box.append(label, select, add);
  if (!eligible.length) box.append(element('p', 'draft-meta',
    'Create a private playlist to organize this private or unlisted video.'));
  return box;
}
function playlistAssignmentText(result) {
  if (!result) return '';
  const title = result.playlistTitle || 'matching playlist';
  if (result.state === 'added') return 'added to ' + title;
  if (result.state === 'already_added') return 'already in ' + title;
  if (result.state === 'fallback_added') return 'needs review; added to private ' + title;
  if (result.state === 'fallback_already_added') return 'needs review; already in private ' + title;
  if (result.state === 'no_match') return 'no confident metadata match; left unassigned for owner review';
  if (result.state === 'ambiguous') return 'multiple playlists matched; left unassigned for owner review';
  if (result.state === 'manual_review') return 'playlist could not be used; left unassigned for owner review';
  if (result.state === 'authorization_required') return 'paused until YouTube is reconnected';
  if (result.state === 'daily_limit') return 'waiting for the daily playlist quota';
  if (result.state === 'retry') return 'will retry: ' + (result.reason || 'temporary YouTube error');
  if (result.state === 'disabled') return 'automatic placement is disabled';
  return String(result.state || 'pending').replaceAll('_', ' ');
}


const ACCEPTED_VERIFIED_GAMEPLAY_HIGHLIGHT_SECONDS = new Set([12 * 60, 15 * 60]);

function hasVerifiedGameplayHighlight(draft) {
  const duration = Number(draft && draft.duration);
  const targetDuration = Number(draft && draft.targetHighlightDurationSeconds);
  if (!draft || draft.sourceType !== 'twitch_highlight_batch' ||
      !ACCEPTED_VERIFIED_GAMEPLAY_HIGHLIGHT_SECONDS.has(targetDuration) ||
      !Number.isFinite(duration) || Math.abs(duration - targetDuration) > 0.5 ||
      draft.mediaValidation !== 'passed' ||
      !Array.isArray(draft.highlights) || !draft.highlights.length ||
      !Array.isArray(draft.twitchClips) || draft.twitchClips.length !== draft.highlights.length) return false;
  return draft.twitchClips.every((clip) => {
    const result = clip && clip.visualGameplayVerification;
    const total = Number(result && result.totalFrames);
    const active = Number(result && result.activeGameplayFrames);
    const confidence = Number(result && result.confidence);
    return result?.verified === true && Number.isFinite(total) && total >= 5 &&
      Number.isFinite(active) && active >= Math.ceil(total * 0.8) && active <= total &&
      Number.isFinite(confidence) && confidence >= 0.8 && confidence <= 1;
  });
}

function formatHighlightDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return 'duration unavailable';
  const wholeSeconds = Math.round(value);
  return Math.floor(wholeSeconds / 60) + ':' + String(wholeSeconds % 60).padStart(2, '0');
}

function isPlaceholderTestStreamTitle(value) {
  const normalized = String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:test|testing|stream test|test stream|live test|test live|vod test|test vod|clip test|test clip)$/.test(normalized);
}

function isNonGameplayTestDraft(draft) {
  if (!draft) return false;
  if (isPlaceholderTestStreamTitle(draft.streamTitle)) return true;
  const normalizedClip = String(draft.twitchClipTitle || draft.title || '').normalize('NFKC')
    .toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:wzbot|wizebot) clip test\b/.test(normalizedClip);
}

function renderDraft(draft, draftsById = new Map()) {
  const isHighlight = draft.sourceType === 'twitch_highlight_batch';
  const isHighlightShort = draft.sourceType === 'twitch_highlight_short';
  const verifiedHighlight = isHighlight && hasVerifiedGameplayHighlight(draft);
  const parentDraft = isHighlightShort ? draftsById.get(String(draft.parentId)) : null;
  const verifiedShort = isHighlightShort && hasVerifiedGameplayHighlight(parentDraft);
  const publishBlocked = isHighlight && !verifiedHighlight || isHighlightShort && !verifiedShort;
  const card = element('article', 'draft');
  const top = element('div', 'draft-top');
  top.append(element('h3', '', draft.title || (isHighlight ? 'Untitled highlight video' : 'Untitled Short')));
  top.append(element('span', 'draft-status', String(draft.status || 'unknown').replaceAll('_', ' ')));
  card.append(top);

  const created = draft.createdAt ? new Date(draft.createdAt).toLocaleString() : 'Unknown date';
  card.append(element('p', 'draft-meta', `Created ${created}`));
  if (draft.playlistAssignment) card.append(element('p', 'draft-meta',
    'Automatic playlist: ' + playlistAssignmentText(draft.playlistAssignment)));
  if (draft.youtubeVideoId) {
    const playlistControl = renderPlaylistAdder(draft.youtubeVideoId,
      draft.youtubePrivacyStatus === 'public' || draft.status === 'published' ? 'public' : 'private');
    if (playlistControl) card.append(playlistControl);
  }

  if (draft.sourceType === 'twitch_vod') {
    const source = element('p', 'draft-meta', `Twitch VOD ${draft.vodId} · ${Math.round(draft.startSeconds || 0)}s–${Math.round(draft.endSeconds || 0)}s`);
    card.append(source);
    if (draft.twitchUrl) {
      const twitchLink = element('a', 'ghost video-link');
      twitchLink.href = draft.twitchUrl;
      twitchLink.target = '_blank';
      twitchLink.rel = 'noopener noreferrer';
      twitchLink.textContent = 'Open Twitch clip';
      card.append(twitchLink);
    }
  }
  if (isHighlight) {
    const measuredDuration = Number(draft.duration) ||
      (draft.highlights || []).reduce((sum, item) => sum + Number(item.duration || 0), 0);
    const verifiedMinutes = Math.round(Number(draft.targetHighlightDurationSeconds) / 60);
    const editLabel = verifiedHighlight ? verifiedMinutes + '-minute gameplay-verified highlight'
      : formatHighlightDuration(measuredDuration) + ' legacy edit · not verified against the 12-minute gameplay target';
    card.append(element('p', 'draft-meta', `Twitch VOD ${draft.vodId} · ${(draft.highlights || []).length} selected moments · ${editLabel} · ${(draft.shortCandidateIndexes || []).length || 2} Shorts`));
    const quality = draft.qualityCalibration;
    if (quality?.calibrated && Number.isFinite(Number(quality.qualityFloor)) &&
        Number.isFinite(Number(quality.qualityCeiling))) {
      card.append(element('p', 'draft-meta',
        `Clip quality floor ${Math.round(Number(quality.qualityFloor) * 100)}/100 · ceiling ${Math.round(Number(quality.qualityCeiling) * 100)}/100 · median/MAD from ${quality.sampleSize} same-VOD clips`));
    } else if (quality && Number.isFinite(Number(quality.sampleSize))) {
      card.append(element('p', 'draft-meta',
        `Clip quality band used fallback ranking (${quality.sampleSize} same-VOD candidates; not enough varied evidence for a reliable floor)`));
    }
    const assessment = draft.youtubeQualityAssessment;
    if (assessment) {
      if (assessment.status === 'low_sample') {
        card.append(element('p', 'draft-meta',
          `Post-upload quality is still measuring: ${Number(assessment.assessedViews) || 0} views so far; the comparison needs at least 100 for a stable reading.`));
      } else if (assessment.status === 'insufficient_retention_data') {
        card.append(element('p', 'draft-meta',
          'YouTube has not returned enough audience-retention data for this 7-day quality check yet.'));
      } else if (assessment.relativeRetentionScore !== null && assessment.relativeRetentionScore !== undefined &&
          Number.isFinite(Number(assessment.relativeRetentionScore))) {
        const score = Math.round(Number(assessment.relativeRetentionScore) * 100);
        const intro = assessment.introRelativeRetentionScore === null || assessment.introRelativeRetentionScore === undefined
          ? '' : ` · first 30 seconds ${Math.round(Number(assessment.introRelativeRetentionScore) * 100)}/100`;
        const engagement = Array.isArray(assessment.engagementByContentType)
          ? assessment.engagementByContentType.find((item) => item && Number.isFinite(Number(item.engagedViews)))
          : null;
        const engagedViews = engagement ? ` · ${Number(engagement.engagedViews).toLocaleString()} engaged views` : '';
        const comparison = assessment.channelBand?.calibrated
          ? 'compared with the channel’s matched highlight cohort'
          : 'channel comparison is still warming up';
        card.append(element('p', 'draft-meta',
          `Post-upload 7-day relative retention ${score}/100${engagedViews}${intro}; ${comparison}. Status: ${String(assessment.status).replaceAll('_', ' ')}.`));
      }
      const channelBand = assessment.channelBand;
      if (channelBand?.calibrated && Number.isFinite(Number(assessment.averageViewPercentage)) &&
          Number.isFinite(Number(channelBand.floor)) && Number.isFinite(Number(channelBand.ceiling))) {
        card.append(element('p', 'draft-meta',
          `Channel comparison from ${channelBand.sampleSize} similar highlights: average viewed ${Number(assessment.averageViewPercentage).toFixed(1)}% · floor ${Number(channelBand.floor).toFixed(1)}% · ceiling ${Number(channelBand.ceiling).toFixed(1)}%.`));
      } else if (channelBand && Number.isFinite(Number(channelBand.sampleSize))) {
        card.append(element('p', 'draft-meta',
          `Channel-only comparison warming up (${channelBand.sampleSize}/${channelBand.requiredSampleSize} comparable highlights with enough views); no general-market benchmark is being inferred.`));
      }
    }
  }
  if (isHighlight && draft.chapterStatus) {
    const moments = draft.chapters?.length ? draft.chapters : (draft.chapterTimestamps || []);
    const label = draft.chapterStatus === 'chapters_added'
      ? 'Chapter timestamps in private description'
      : 'Moment timestamps in private description';
    if (moments.length) {
      card.append(element('p', 'draft-meta', label + ': ' +
        moments.map((item) => item.time + ' ' + item.title).join(' · ')));
    }
  }
  if (isHighlight && draft.thumbnailStatus) {
    const thumbnailMessage = draft.thumbnailStatus === 'applied'
      ? 'High-contrast gameplay thumbnail generated and added to the private highlight.'
      : draft.thumbnailStatus === 'failed'
        ? 'Thumbnail was not applied: ' + (draft.thumbnailError || 'generation or YouTube upload failed')
        : 'Gameplay thumbnail: ' + String(draft.thumbnailStatus).replaceAll('_', ' ');
    card.append(element('p', draft.thumbnailStatus === 'failed' ? 'draft-error' : 'draft-meta', thumbnailMessage));
  }
  if (draft.status === 'awaiting_owner_approval' && draft.productionState === 'ready' && !publishBlocked) {
    const message = isHighlight
      ? 'The gameplay highlight passed exact-duration checks. Every source segment passed the visual gameplay check, and the selected Shorts passed media validation. Review the private bundle before publishing.'
      : 'This Short passed media validation and YouTube processing, and its SEO package is registered. Review before publishing.';
    card.append(element('p', 'draft-meta', message));
  }
  if (draft.seoRegistrationError && !draft.error) {
    card.append(element('p', 'draft-error', 'SEO job needs retry: ' + draft.seoRegistrationError));
  }
  if (isHighlightShort) {
    card.append(element('p', publishBlocked ? 'draft-error' : 'draft-meta',
      publishBlocked
        ? 'This Short is linked to a legacy or unverified highlight and cannot be published. Keep it private.'
        : 'Short made from a verified highlight video'));
  }

  if (draft.error) card.append(element('p', 'draft-error', draft.error));

  const privateReviewUpload = Boolean(draft.youtubeVideoId) &&
    (draft.youtubePrivacyStatus === 'private' ||
      (!draft.youtubePrivacyStatus && draft.status === 'awaiting_owner_approval'));
  if (draft.youtubeUrl || draft.youtubeVideoId) {
    const link = element('a', 'ghost video-link');
    link.href = privateReviewUpload
      ? `https://studio.youtube.com/video/${encodeURIComponent(draft.youtubeVideoId)}/edit`
      : (draft.youtubeUrl || `https://youtu.be/${encodeURIComponent(draft.youtubeVideoId)}`);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = privateReviewUpload ? 'Review in YouTube Studio' : 'Open on YouTube';
    card.append(link);
    if (privateReviewUpload) {
      const previewLink = element('a', 'ghost video-link', 'Open private video preview');
      previewLink.href = `https://youtu.be/${encodeURIComponent(draft.youtubeVideoId)}`;
      previewLink.target = '_blank';
      previewLink.rel = 'noopener noreferrer';
      card.append(previewLink);
      card.append(element('p', 'draft-meta',
        'Private review upload: YouTube requires a signed-in Google account with access to this video. Amaana’s connection does not sign in your browser. The upload stays private until you choose Publish now.'));
    }
  }

  if (draft.sourceType === 'twitch_highlight_short' && draft.youtubeVideoId) {
    const status = draft.tiktokStatus || 'not_sent';
    const eligible = draft.tiktokEligible && draft.youtubePrivacyStatus === 'public' && draft.youtubeViews > 2000;
    const viewText = Number.isSafeInteger(draft.youtubeViews)
      ? `${draft.youtubeViews.toLocaleString()} YouTube views` : 'YouTube views not checked yet';
    card.append(element('p', 'draft-meta', `${viewText} · ${eligible ? 'Eligible for TikTok' : 'TikTok requires a public Short with more than 2,000 views'}`));
    const checkViews = element('button', 'ghost', 'Check YouTube views');
    checkViews.type = 'button';
    checkViews.addEventListener('click', async () => {
      checkViews.disabled = true;
      try {
        const result = await api(`/api/drafts/${encodeURIComponent(draft.id)}/youtube-views`);
        showNotice(result.eligible
          ? `Short eligible: ${result.views.toLocaleString()} YouTube views.`
          : `TikTok needs over 2,000 public YouTube views. Current views: ${result.views?.toLocaleString() ?? 'unavailable'}.`);
        await loadDrafts();
      } catch (error) { showNotice(error.message, true); checkViews.disabled = false; }
    });
    card.append(checkViews);
    card.append(element('p', 'draft-meta', `TikTok: ${status.replaceAll('_', ' ')}`));
    if (draft.tiktokError) card.append(element('p', 'draft-error', draft.tiktokError));
    const caption = `${draft.title || 'Saevond livestream highlight'} #Saevond #Gaming`;
    if ((!draft.tiktokPublishId && status !== 'preparing') || status === 'failed') {
      const captionBox = element('p', 'draft-meta', `Suggested TikTok caption: ${caption}`);
      card.append(captionBox);
      const copy = element('button', 'ghost', 'Copy TikTok caption');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(caption); showNotice('Caption copied for TikTok.'); }
        catch { showNotice('Select and copy the suggested caption above.', true); }
      });
      card.append(copy);
      if (!draft.tiktokAttemptedAt && status !== 'failed') {
        if (draft.tiktokAutoSendConsent) {
          card.append(element('p', 'draft-meta', 'Automatic TikTok inbox delivery enabled for this Short. It will run after the public YouTube Short exceeds 2,000 views.'));
          const cancelAuto = element('button', 'ghost', 'Turn off automatic delivery');
          cancelAuto.type = 'button';
          cancelAuto.addEventListener('click', async () => {
            cancelAuto.disabled = true;
            try {
              await api(`/api/drafts/${encodeURIComponent(draft.id)}/tiktok-auto`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ consent: false })
              });
              showNotice('Automatic TikTok delivery turned off for this Short.');
              await loadDrafts();
            } catch (error) { showNotice(error.message, true); cancelAuto.disabled = false; }
          });
          card.append(cancelAuto);
        } else {
          const autoConsentRow = element('label', 'check-row');
          const autoConsent = document.createElement('input');
          autoConsent.type = 'checkbox';
          autoConsentRow.append(autoConsent, element('span', '', 'I reviewed this Short and authorize Amaana to send its video and audio to my TikTok inbox automatically once it exceeds 2,000 public YouTube views. I will finish publishing in TikTok.'));
          card.append(autoConsentRow);
          const enableAuto = element('button', 'ghost', 'Enable automatic TikTok delivery');
          enableAuto.type = 'button';
          enableAuto.disabled = true;
          autoConsent.addEventListener('change', () => { enableAuto.disabled = !tiktokConnected || !autoConsent.checked; });
          enableAuto.addEventListener('click', async () => {
            enableAuto.disabled = true;
            try {
              await api(`/api/drafts/${encodeURIComponent(draft.id)}/tiktok-auto`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ consent: autoConsent.checked })
              });
              showNotice('Automatic TikTok inbox delivery enabled for this Short after it passes 2,000 public YouTube views.');
              await loadDrafts();
            } catch (error) { showNotice(error.message, true); enableAuto.disabled = !tiktokConnected || !autoConsent.checked; }
          });
          card.append(enableAuto);
        }
      }
      if (!draft.tiktokAutoSendConsent || status === 'failed') {
        const consentRow = element('label', 'check-row');
        const consent = document.createElement('input');
        consent.type = 'checkbox';
        consentRow.append(consent, element('span', '', 'I reviewed this Short and agree to send its video and audio to my TikTok inbox.'));
        card.append(consentRow);
        const send = element('button', 'ghost', 'Send to TikTok inbox');
        send.type = 'button';
        send.disabled = true;
        consent.addEventListener('change', () => { send.disabled = !tiktokConnected || !eligible || !consent.checked; });
        send.addEventListener('click', async () => {
          send.disabled = true;
          send.textContent = 'Preparing TikTok video…';
          try {
            await api(`/api/drafts/${encodeURIComponent(draft.id)}/tiktok-inbox`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ consent: consent.checked })
            });
            showNotice('Preparing your Short for TikTok. Check status shortly, then finish posting from your TikTok inbox.');
            await loadDrafts();
          } catch (error) {
            showNotice(error.message, true);
            send.textContent = 'Send to TikTok inbox';
            send.disabled = !tiktokConnected || !eligible || !consent.checked;
          }
        });
        card.append(send);
      }
    } else if (status !== 'published') {
      const refresh = element('button', 'ghost', 'Check TikTok status');
      refresh.type = 'button';
      refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        try {
          const result = await api(`/api/drafts/${encodeURIComponent(draft.id)}/tiktok-status`);
          showNotice(result.status === 'ready_in_tiktok_inbox'
            ? 'TikTok delivered the clip. Open your TikTok inbox to edit and post it.'
            : `TikTok: ${result.status.replaceAll('_', ' ')}`);
          await loadDrafts();
        } catch (error) { showNotice(error.message, true); refresh.disabled = false; }
      });
      card.append(refresh);
    }
  }

  if (draft.status === 'awaiting_owner_approval' && !publishBlocked) {
    const actions = element('div', 'draft-actions');
    const publish = element('button', 'publish', 'Publish now');
    publish.type = 'button';
    publish.addEventListener('click', () => {
      if (window.confirm(`Publish this ${isHighlight ? 'highlight video' : 'Short'} publicly now?`)) approveDraft(draft.id, null, publish);
    });

    const scheduleRow = element('div', 'schedule-row');
    const scheduleTime = document.createElement('input');
    scheduleTime.type = 'datetime-local';
    scheduleTime.setAttribute('aria-label', 'Schedule date and time');
    scheduleTime.min = new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 16);
    const schedule = element('button', 'ghost', 'Schedule');
    schedule.type = 'button';
    schedule.addEventListener('click', () => {
      if (!scheduleTime.value) return showNotice('Choose a future date and time first.', true);
      const date = new Date(scheduleTime.value);
      if (Number.isNaN(date.getTime()) || date <= new Date()) return showNotice('Choose a valid future time.', true);
      approveDraft(draft.id, date.toISOString(), schedule);
    });
    scheduleRow.append(scheduleTime, schedule);
    actions.append(publish, scheduleRow);
    card.append(actions);
  }

  if (draft.status === 'awaiting_owner_approval' && publishBlocked && !isHighlightShort) {
    card.append(element('p', 'draft-error', 'This highlight is not verified against the 12-minute target or the legacy 15-minute target. Publishing is disabled; keep it private.'));
  }

  if (draft.status === 'clip_failed' || (isHighlight && draft.error)) {
    const retry = element('button', 'ghost', 'Retry processing');
    retry.type = 'button';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      retry.textContent = 'Retrying…';
      try {
        await api(`/api/drafts/${encodeURIComponent(draft.id)}/retry`, { method: 'POST' });
        showNotice('Highlight job queued again.');
        await loadDrafts();
      } catch (error) {
        showNotice(error.message, true);
        retry.disabled = false;
        retry.textContent = 'Retry processing';
      }
    });
    card.append(retry);
  }
  if ((isHighlight || draft.sourceType === 'twitch_vod') && isNonGameplayTestDraft(draft)) {
    card.append(element('p', 'draft-error',
      'This Twitch source is marked as a test, so Amaana will exclude it and related clips from review.'));
    const exclude = element('button', 'ghost', 'Remove test VOD and related clips from review');
    exclude.type = 'button';
    exclude.addEventListener('click', async () => {
      exclude.disabled = true;
      exclude.textContent = 'Removing…';
      try {
        const result = await api('/api/drafts/' + encodeURIComponent(draft.id) + '/exclude-test-vod', { method: 'POST' });
        showNotice(result.excludedCount + ' test VOD items removed from the active review queue. YouTube visibility was not changed.');
        await loadDrafts();
      } catch (error) {
        showNotice(error.message, true);
        exclude.disabled = false;
        exclude.textContent = 'Remove test VOD and related clips from review';
      }
    });
    card.append(exclude);
  }

  return card;
}

function seoHeading(label, value) {
  const section = element('div', 'seo-field');
  section.append(element('h4', '', label), element('p', 'seo-copy', value));
  return section;
}

function formatSearchCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat().format(number) : '0';
}

function formatSearchPosition(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toFixed(1) : 'not available';
}

function periodDays(snapshot) {
  const start = Date.parse(String(snapshot.periodStart || '') + 'T00:00:00Z');
  const end = Date.parse(String(snapshot.periodEnd || '') + 'T00:00:00Z');
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.round((end - start) / 86400000) + 1 : null;
}

function searchChange(current, previous) {
  const now = Number(current);
  const before = Number(previous);
  if (!Number.isFinite(now) || !Number.isFinite(before)) return 'unavailable';
  if (before === 0) return now === 0 ? 'unchanged from 0' : 'up from 0 to ' + formatSearchCount(now);
  const change = ((now - before) / before) * 100;
  const rounded = Math.round(Math.abs(change) * 10) / 10;
  return (change > 0 ? '+' : change < 0 ? '−' : '') + rounded + '%';
}

function googleSearchSummary(item) {
  const snapshots = Array.isArray(item.googleSearchSnapshots) ? item.googleSearchSnapshots : [];
  const current = snapshots[0];
  if (!current) return null;
  const clicks = Number(current.clicks) || 0;
  const impressions = Number(current.impressions) || 0;
  const ctr = impressions ? (clicks / impressions) * 100 : 0;
  const section = element('div', 'seo-field');
  section.append(element('h4', '', 'Google Search Console'),
    element('p', 'draft-meta', current.periodStart + '–' + current.periodEnd + ': ' +
      formatSearchCount(impressions) + ' impressions · ' + formatSearchCount(clicks) +
      ' clicks · ' + ctr.toFixed(2) + '% CTR · average position ' +
      formatSearchPosition(current.averagePosition) + '.'));
  const previous = snapshots[1];
  const sameLength = previous && periodDays(current) === periodDays(previous);
  const nonOverlapping = previous && current.periodStart > previous.periodEnd;
  if (sameLength && nonOverlapping) {
    const currentPosition = Number(current.averagePosition);
    const previousPosition = Number(previous.averagePosition);
    let positionText = 'average position unavailable in one period';
    if (Number.isFinite(currentPosition) && currentPosition > 0 &&
        Number.isFinite(previousPosition) && previousPosition > 0) {
      const movement = previousPosition - currentPosition;
      positionText = movement > 0
        ? 'average position improved from ' + previousPosition.toFixed(1) + ' to ' + currentPosition.toFixed(1)
        : movement < 0
          ? 'average position moved down from ' + previousPosition.toFixed(1) + ' to ' + currentPosition.toFixed(1)
          : 'average position stayed at ' + currentPosition.toFixed(1);
    }
    section.append(element('p', 'draft-meta',
      'Vs ' + previous.periodStart + '–' + previous.periodEnd + ': impressions ' +
      searchChange(current.impressions, previous.impressions) + ' · clicks ' +
      searchChange(current.clicks, previous.clicks) + ' · ' + positionText + '.'));
  } else if (previous) {
    section.append(element('p', 'draft-meta',
      'Previous imported period ' + previous.periodStart + '–' + previous.periodEnd + ': ' +
      formatSearchCount(previous.impressions) + ' impressions, ' +
      formatSearchCount(previous.clicks) + ' clicks, average position ' +
      formatSearchPosition(previous.averagePosition) +
      '. Equal-length, non-overlapping periods are needed for a fair comparison.'));
  }
  section.append(element('p', 'fine-print',
    'Search Console average position is an aggregate Google Search metric, not a fixed rank for every person or location.'));
  return section;
}


function youtubeSearchAnalyticsSummary(item) {
  const snapshots = Array.isArray(item.youtubeSearchSnapshots) ? item.youtubeSearchSnapshots : [];
  const current = snapshots[0];
  if (!current) return null;
  const googleViews = current.googleSearchReferralViews === null ||
    current.googleSearchReferralViews === undefined ? null : Number(current.googleSearchReferralViews);
  const googleText = googleViews === null
    ? 'unavailable in the top ' + (Number(current.googleSearchDetailRows) || 25) + ' external sources'
    : current.googleSearchReferralComplete
      ? formatSearchCount(googleViews)
      : 'at least ' + formatSearchCount(googleViews);
  const section = element('div', 'seo-field');
  section.append(element('h4', '', 'YouTube Analytics search traffic · autopilot'),
    element('p', 'draft-meta', current.periodStart + '–' + current.periodEnd + ': ' +
      googleText + ' Google-domain referral views · ' +
      formatSearchCount(current.youtubeSearchViews) + ' YouTube Search views.'));
  const previous = snapshots[1];
  const sameLength = previous && periodDays(current) === periodDays(previous);
  const nonOverlapping = previous && current.periodStart > previous.periodEnd;
  if (sameLength && nonOverlapping) {
    const googleComparable = current.googleSearchReferralComplete && previous.googleSearchReferralComplete &&
      googleViews !== null && previous.googleSearchReferralViews !== null;
    section.append(element('p', 'draft-meta',
      'Vs ' + previous.periodStart + '–' + previous.periodEnd + ': Google-domain referrals ' +
      (googleComparable
        ? searchChange(googleViews, previous.googleSearchReferralViews)
        : 'not comparable because external-source details are incomplete') +
      ' · YouTube Search views ' +
      searchChange(current.youtubeSearchViews, previous.youtubeSearchViews) + '.'));
  }
  section.append(element('p', 'fine-print',
    'These are video views attributed to traffic sources, not Google Search impressions, CTR, or average position. Search Console imports remain the ranking-performance source.'));
  return section;
}

function renderSeoVideo(item) {
  const card = element('article', 'draft');
  const top = element('div', 'draft-top');
  top.append(element('h3', '', item.source.title || item.videoId),
    element('span', 'draft-status', item.status.replaceAll('_', ' ')));
  card.append(top);
  const link = element('a', 'ghost video-link', 'Open on YouTube');
  link.href = `https://youtu.be/${encodeURIComponent(item.videoId)}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  card.append(link);
  const audioLanguage = item.source.defaultAudioLanguage || 'not set';
  card.append(element('p', 'draft-meta', `Original spoken-audio language: ${audioLanguage}`));
  const studioLanguages = element('a', 'ghost video-link', 'Check generated tracks in YouTube Studio');
  studioLanguages.href = `https://studio.youtube.com/video/${encodeURIComponent(item.videoId)}/translations`;
  studioLanguages.target = '_blank';
  studioLanguages.rel = 'noopener noreferrer';
  card.append(studioLanguages);
  if (item.error) card.append(element('p', 'draft-error', item.error));
  card.append(element('p', 'draft-meta', `YouTube visibility: ${item.source.privacyStatus || 'unknown'}`));
  if (item.source?.privacyStatus === 'public') {
    const rawViews = String(item.source.viewCount ?? '');
    const views = /^\d+$/.test(rawViews)
      ? rawViews.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : null;
    card.append(element('p', 'draft-meta', views === null
      ? 'View count unavailable; public videos with known low counts are queued first.'
      : `YouTube views: ${views} · low-view public videos are queued first. Use Studio impressions, CTR, retention, and traffic sources to assess performance.`));
    const studioAnalytics = element('a', 'ghost video-link', 'Open YouTube Studio analytics');
    studioAnalytics.href = `https://studio.youtube.com/video/${encodeURIComponent(item.videoId)}/analytics/tab-overview`;
    studioAnalytics.target = '_blank';
    studioAnalytics.rel = 'noopener noreferrer';
    card.append(studioAnalytics);
    const analyticsSummary = youtubeSearchAnalyticsSummary(item);
    if (analyticsSummary) card.append(analyticsSummary);
    const searchSummary = googleSearchSummary(item);
    if (searchSummary) card.append(searchSummary);
  }
  if (item.playlistResult) card.append(element('p', 'draft-meta',
    'Automatic playlist: ' + playlistAssignmentText(item.playlistResult)));
  const playlistControl = renderPlaylistAdder(item.videoId, item.source.privacyStatus || 'unknown');
  if (playlistControl) card.append(playlistControl);
  if (item.applied) card.append(element('p', 'draft-meta',
    `SEO applied to this video on ${new Date(item.applied.at).toLocaleString()}.`));
  if (item.autoResult?.state === 'skipped') card.append(element('p', 'draft-meta',
    `Automatic SEO skipped: ${item.autoResult.reason}`));
  if (item.autoResult?.state === 'retry') {
    const reconnectNeeded = /invalid_grant|invalid credentials|autherror|unauthenticated|insufficient.{0,30}(scope|permission)|refresh token.{0,30}(expired|revoked|invalid)/i
      .test(item.autoResult.reason || '');
    card.append(element('p', reconnectNeeded ? 'draft-error' : 'draft-meta', reconnectNeeded
      ? 'YouTube authorization failed; reconnect to resume this public SEO edit automatically.'
      : `Automatic SEO will retry: ${item.autoResult.reason}`));
  }
  if (item.autoResult?.thumbnailState === 'applied') card.append(element('p', 'draft-meta',
    `SEO thumbnail updated: ${item.autoResult.thumbnailHeadline || 'thumbnail'}`));
  const thumbnailSelection = item.autoResult?.thumbnailSelection;
  if (thumbnailSelection?.score != null) card.append(element('p', 'draft-meta',
    `Thumbnail rating: ${thumbnailSelection.score}/100 (${thumbnailSelection.grade}); option ${thumbnailSelection.option} selected by evidence/readability/contrast heuristic, not a YouTube experiment.`));
  if (item.autoResult?.thumbnailState === 'skipped') card.append(element('p', 'draft-meta',
    `SEO thumbnail skipped: ${item.autoResult.thumbnailReason}`));
  if (item.autoResult?.thumbnailState === 'retry') card.append(element('p', 'draft-meta',
    `SEO thumbnail will retry: ${item.autoResult.thumbnailReason}`));
  if (item.audit?.length) card.append(seoHeading('Current SEO findings', item.audit.join('\n')));

  const details = document.createElement('details');
  details.className = 'seo-details';
  details.append(element('summary', '', item.package ? 'Inspect package or add context' : 'Add video context'));
  if (item.package) {
    const pkg = item.package;
    details.append(seoHeading('Primary keyword', pkg.primaryKeyword));
    if (pkg.evidence?.marketObservedAt) {
      const metrics = pkg.evidence.marketMetrics || {};
      const phrases = (pkg.evidence.marketTerms || [])
        .map((entry) => `${entry.phrase} (score ${entry.score}, ${entry.sampleCount} examples)`)
        .join('\n');
      details.append(seoHeading('Current market research', [
        `Observed ${new Date(pkg.evidence.marketObservedAt).toLocaleString()}`,
        `Search-result sample: ${pkg.evidence.marketSampleSize || 0}`,
        `Smoothed median / 90th percentile views per day: ${metrics.medianViewsPerDay ?? 'n/a'} / ${metrics.p90ViewsPerDay ?? 'n/a'}`,
        `Median absolute deviation: ${metrics.medianAbsoluteDeviation ?? 'n/a'} · confidence heuristic: ${metrics.confidence ?? 'n/a'}`,
        phrases ? `Recurring market phrases (evidence only):\n${phrases}` : '',
        'Search-result sample only; this is not search volume or a view forecast.'
      ].filter(Boolean).join('\n')));
    }
    if (pkg.evidence?.vidiqObservedAt) {
      const rows = (pkg.evidence.vidiqRows || []).map((row) => {
        const monthly = row.estimatedMonthlySearch?.display || 'unknown';
        const growth = Number.isFinite(row.searchDemandGrowthPct)
          ? `${row.searchDemandGrowthPct > 0 ? '+' : ''}${row.searchDemandGrowthPct}%` : 'unknown';
        return `${row.keyword} · estimated monthly searches ${monthly} · competition ${row.competitionScore ?? 'unknown'}/100 · growth ${growth} · ${row.sourceSupport === 'supported_by_video_or_owner_context' ? 'matches supplied video/context' : 'not verified against footage/context'}`;
      });
      details.append(seoHeading('VidIQ keyword research · review required', [
        `Query: ${pkg.evidence.vidiqQuery || 'unknown'}`,
        `Observed: ${new Date(pkg.evidence.vidiqObservedAt).toLocaleString()}`,
        ...rows,
        'vidIQ values are directional estimates, not forecasts or proof of video content. This package cannot be auto-applied; verify every phrase against the actual footage.'
      ].join('\n')));
    }
    for (const group of ['search', 'curiosity', 'hybrid']) {
      details.append(seoHeading(`${group[0].toUpperCase() + group.slice(1)} titles`,
        (pkg.titles?.[group] || []).map((title, index) => `${index + 1}. ${title}`).join('\n')));
    }
    (pkg.thumbnails || []).forEach((brief, index) => {
      const rating = brief.rating;
      const selected = pkg.thumbnailSelection?.selectedIndex === index;
      const ratingText = rating
        ? `Rating: ${rating.score}/100 (${rating.grade}) — ${rating.recommendable ? 'recommended' : 'not recommended'}\nReasons: ${rating.reasons.join(' ')}\n`
        : 'No rating available.\n';
      details.append(seoHeading(`Thumbnail ${index + 1}${selected ? ' — selected' : ''}`,
        `${ratingText}${brief.overlay}\nVisual: ${brief.visual}\nPalette: ${brief.palette}\nHook: ${brief.hook}`));
    });
    details.append(seoHeading('How ratings work',
      'Evidence, short-text readability, fixed text contrast, topic fit, and title-complement heuristic only. It does not inspect image pixels or layout, or predict CTR, views, or watch time. Use eligible YouTube Studio Test & Compare experiments for performance evidence.'));
    details.append(seoHeading('Full description', pkg.description || ''));
    details.append(seoHeading('Tags', (pkg.tags || []).join(', ')));
    details.append(seoHeading('Pinned comment', pkg.pinnedComment || ''));
    details.append(seoHeading('Community post', pkg.communityPost || ''));
    details.append(seoHeading('Shorts clips', (pkg.shorts || []).map((clip) =>
      `${clip.start}–${clip.end}: ${clip.title} — ${clip.hook}`).join('\n') || 'Add verified clip windows.'));
    if (pkg.missingEvidence?.length) {
      details.append(seoHeading('Evidence gaps', pkg.missingEvidence.join('\n')));
    }
    const copy = element('button', 'ghost', 'Copy complete package');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(pkg, null, 2)); showNotice('SEO package copied.'); }
      catch { showNotice('Clipboard unavailable on this device.', true); }
    });
    details.append(copy);
  }
  if (item.analysis) {
    const analysis = item.analysis;
    details.append(seoHeading('Video analysis (AI suggestions; review before using)', [
      analysis.summary,
      analysis.spokenSummary ? `Audio: ${analysis.spokenSummary}` : 'No clear speech summary',
      analysis.visualContext ? `Visuals: ${analysis.visualContext}` : '',
      analysis.topics?.length ? `Topics: ${analysis.topics.join(', ')}` : '',
      analysis.speakerTone ? `Tone: ${analysis.speakerTone}` : '',
      analysis.audience ? `Suggested audience: ${analysis.audience}` : '',
      analysis.entities?.length ? `Entities: ${analysis.entities.join(', ')}` : '',
      analysis.primaryKeyword ? `Suggested keyword: ${analysis.primaryKeyword}` : '',
      analysis.secondaryKeywords?.length ? `Related phrases: ${analysis.secondaryKeywords.join(', ')}` : '',
      analysis.category ? `Suggested category: ${analysis.category}` : '',
      analysis.tags?.length ? `Suggested tags: ${analysis.tags.join(', ')}` : '',
      analysis.moments?.length ? `Approximate moments (not chapters): ${analysis.moments.map((moment) =>
        `${moment.time} ${moment.detail}`).join('; ')}` : ''
    ].filter(Boolean).join('\n')));
  }

  const form = element('form', 'seo-context');
  for (const [name, label, multiline] of [
    ['topic', 'Main topic', false], ['primaryKeyword', 'Primary keyword', false],
    ['takeaways', 'Key moments or script', true], ['audience', 'Target audience', false],
    ['videoType', 'Video type', false]
  ]) {
    const field = document.createElement(multiline ? 'textarea' : 'input');
    field.name = name;
    field.value = item.context?.[name] || '';
    if (multiline) field.rows = 3;
    form.append(element('label', '', label), field);
  }
  const markers = document.createElement('textarea');
  markers.name = 'markers';
  markers.rows = 4;
  markers.value = JSON.stringify(item.context?.markers || [], null, 2);
  markers.placeholder = '[{"kind":"chapter","startSeconds":0,"title":"Intro"},{"kind":"clip","startSeconds":120,"endSeconds":155,"title":"Clutch moment"}]';
  form.append(element('label', '', 'Verified chapter and clip markers (JSON)'), markers,
    element('p', 'draft-meta', 'Use seconds from the actual video. Chapters need at least three markers starting at 0, spaced 10 seconds apart.'));
  const save = element('button', 'primary', 'Save context and regenerate');
  save.type = 'submit';
  form.append(save);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const fields = Object.fromEntries(new FormData(form));
      fields.markers = JSON.parse(fields.markers);
      await api(`/api/seo/videos/${encodeURIComponent(item.videoId)}/context`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields)
      });
      showNotice('Context saved. A new package is queued.');
      await loadSeo();
    } catch (error) { showNotice(error.message, true); save.disabled = false; }
  });
  details.append(form);
  const regenerate = element('button', 'ghost', 'Retry package without changing context');
  regenerate.type = 'button';
  regenerate.addEventListener('click', async () => {
    regenerate.disabled = true;
    try {
      await api(`/api/seo/videos/${encodeURIComponent(item.videoId)}/regenerate`, { method: 'POST' });
      showNotice('SEO package queued again.');
      await loadSeo();
    } catch (error) { showNotice(error.message, true); regenerate.disabled = false; }
  });
  details.append(regenerate);
  card.append(details);
  return card;
}

async function loadSeo() {
  try {
    const [status, videos] = await Promise.all([
      api('/api/seo/status'), api(`/api/seo/videos?offset=${seoOffset}`)
    ]);
    seoEnabled = status.enabled !== false;
    const counts = status.statuses || {};
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const coverage = status.playlistCoverageAudit;
    const coverageStatus = coverage
      ? coverage.complete && coverage.catalogScanComplete
        ? `Playlist coverage ${coverage.coveredCount || 0}/${coverage.catalogCount || 0}; ${coverage.missingCount || 0} missing${coverage.requeuedCount ? `; ${coverage.requeuedCount} queued for repair` : ''}`
        : `Playlist coverage audit incomplete; ${coverage.failedPlaylistCount || 0} playlists unread`
      : status.completed ? 'Playlist coverage audit pending' : null;
    seoStatus.textContent = [
      status.channelTitle ? `Connected channel: ${status.channelTitle}` : 'Waiting for channel connection',
      `${total} videos found; ${counts.ready || 0} ready, ${counts.needs_review || 0} need review, ${counts.queued || 0} queued, ${counts.retry || 0} retry, ${counts.generating || 0} generating, ${counts.failed || 0} failed`,
      `${status.appliedTotal || 0} public videos updated by Amaana`,
      status.completed ? 'Catalog scan complete' : 'Catalog scan in progress',
      coverageStatus,
      status.youtubeAnalyticsAuthorized
        ? (status.youtubeSearchAnalyticsNeedsReconnect
          ? 'Google rejected the saved YouTube token; reconnect to resume Analytics and queued public SEO edits'
          : status.youtubeSearchAnalyticsLastAttemptAt
          ? 'Read-only search-traffic autopilot active; last batch ' +
            new Date(status.youtubeSearchAnalyticsLastAttemptAt).toLocaleString()
          : 'Read-only search-traffic autopilot enabled')
        : 'Reconnect YouTube to grant read-only Analytics access for search-traffic autopilot',
      status.youtubeSearchAnalyticsLastError
        ? 'Analytics sync issue: ' + status.youtubeSearchAnalyticsLastError : null,
      status.providerConfigured ? `${status.attemptedToday}/${status.dailyLimit} AI attempts today (UTC)`
        : 'Configure SEO_AI_API_KEY and SEO_AI_MODEL to create packages',
      status.videoAnalysisEnabled ? 'Video analysis on for public videos' : 'Video analysis off',
      status.providerError ? `${status.providerError}; next retry after ${new Date(status.providerBlockedUntil).toLocaleString()}` : null,
      status.youtubeDataApiBlockedUntil
        ? `YouTube Data API work paused until ${new Date(status.youtubeDataApiBlockedUntil).toLocaleString()}` : null,
      status.autoPublishEnabled ? 'Automatic public video SEO on' : 'Automatic publishing disabled',
      seoEnabled ? 'SEO jobs active' : 'SEO jobs paused'
    ].filter(Boolean).join(' · ');
    seoToggle.textContent = seoEnabled ? 'Pause SEO jobs' : 'Resume SEO jobs';
    seoList.replaceChildren(...(videos.length ? videos.map(renderSeoVideo) :
      [element('div', 'empty-state', 'No channel videos in this page yet. Refresh after the next catalog scan.')]));
    seoPage.textContent = `${total ? seoOffset + 1 : 0}–${Math.min(total, seoOffset + videos.length)} of ${total}`;
    seoPrevious.disabled = seoOffset === 0;
    seoNext.disabled = seoOffset + videos.length >= total;
  } catch (error) {
    if (error.status === 401) return showLogin();
    seoStatus.textContent = error.message;
  }
}

async function loadChannelSeo() {
  try {
    const channel = await api('/api/seo/channel');
    const japanese = channel.localizations?.ja;
    channelLocalizationSnapshot = { id: channel.id, etag: channel.etag };
    seoChannel.replaceChildren(
      element('p', 'draft-meta', `${channel.title} · ${channel.id}`),
      element('p', '', `Description: ${channel.description || '(empty)'}`),
      element('p', '', `Keywords: ${channel.keywords || '(empty)'}`),
      element('p', 'draft-meta', channel.audit?.length
        ? `Findings: ${channel.audit.join(' ')}`
        : 'Channel description and keywords are present.')
    );
    channelJaTitle.value = japanese?.title || channel.japaneseSuggestion?.title || channel.title;
    channelJaDescription.value = japanese?.description || channel.japaneseSuggestion?.description || '';
    channelJaStatus.textContent = japanese
      ? 'Existing Japanese localization loaded. Saving will update only Japanese channel metadata.'
      : 'Japanese profile suggestion loaded. Save it here, or let autopilot translate and save it automatically.';
    const sourceLanguage = channel.defaultLanguage || 'en';
    channelJaStatus.textContent += ` Default channel language stays ${sourceLanguage}.`;
    channelJaForm.hidden = false;
  } catch (error) {
    if (error.status === 401) return showLogin();
    channelJaForm.hidden = true;
    channelLocalizationSnapshot = null;
    seoChannel.textContent = error.message;
  }
}

function renderJapaneseAutopilotStatus(state) {
  japaneseAutopilotState = state;
  jaAutopilotToggle.textContent = state.enabled ? 'Pause Japanese autopilot' : 'Enable Japanese autopilot';
  jaAutopilotToggle.setAttribute('aria-pressed', String(state.enabled === true));
  const run = state.lastRun || {};
  const completed = state.lastRunFinishedAt
    ? ' Last run finished ' + new Date(state.lastRunFinishedAt).toLocaleString() + '.'
    : '';
  const counts = 'Latest batch saved ' + (run.channel || 0) + ' channel profile, ' +
    (run.videos || 0) + ' videos, and ' + (run.playlists || 0) + ' playlists.';
  const error = state.lastError ? ' Last error: ' + state.lastError : '';
  jaAutopilotStatus.textContent = (state.enabled ? 'Enabled' : 'Paused') + ' · ' +
    (state.status || 'idle') + ' · ' + (state.updatesToday || 0) + '/' +
    (state.dailyLimit || 100) + ' YouTube metadata updates today.' + completed + ' ' + counts + error;
}

async function loadJapaneseAutopilotStatus() {
  if (japaneseAutopilotLoading) return;
  japaneseAutopilotLoading = true;
  try {
    const state = await api('/api/seo/localization/ja/autopilot');
    renderJapaneseAutopilotStatus(state);
    if (japaneseAutopilotKnownTotalUpdated !== null &&
        japaneseAutopilotKnownTotalUpdated !== state.totalUpdated) {
      await loadChannelSeo();
    }
    japaneseAutopilotKnownTotalUpdated = state.totalUpdated;
  } catch (error) {
    jaAutopilotStatus.textContent = error.message || 'Could not load Japanese autopilot status.';
    if (error.status === 401) showLogin();
  } finally {
    japaneseAutopilotLoading = false;
  }
}

async function loadPlaylists() {
  try {
    const result = await api('/api/youtube/playlists');
    youtubePlaylists = Array.isArray(result) ? result : [];
    if (!youtubePlaylists.length) {
      playlistList.replaceChildren(element('div', 'empty-state', 'No playlists found yet. Create one below.'));
      return;
    }
    playlistList.replaceChildren(...youtubePlaylists.map((playlist) => {
      const row = element('div', 'playlist-row');
      const link = element('a', 'video-link', playlist.title || 'Untitled playlist');
      link.href = 'https://www.youtube.com/playlist?list=' + encodeURIComponent(playlist.id);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.append(link, element('span', 'draft-status', playlist.privacyStatus));
      return row;
    }));
  } catch (error) {
    youtubePlaylists = [];
    playlistList.replaceChildren(element('div', 'empty-state', error.message || 'Could not load playlists.'));
    if (error.status === 401) showLogin();
  }
}
async function loadDrafts() {
  try {
    const drafts = (await api('/api/drafts')).filter((draft) => draft?.status !== 'excluded_by_owner');
    draftList.replaceChildren();
    if (!drafts.length) {
      draftList.append(element('div', 'empty-state', 'No drafts yet. Upload a Short above or let your agent create one.'));
      return;
    }
    const draftsById = new Map(drafts.map((draft) => [String(draft.id), draft]));
    drafts.forEach((draft) => draftList.append(renderDraft(draft, draftsById)));
  } catch (error) {
    if (error.status === 401) return showLogin();
    draftList.replaceChildren(element('div', 'empty-state', error.message));
  }
}

async function refreshDashboard() {
  try {
    await Promise.all([refreshConnection(), refreshTwitchConnection(), refreshTikTokConnection(), loadPlaylists()]);
    await loadDrafts();
    await loadSeo();
    await loadChannelSeo();
    await loadJapaneseAutopilotStatus();
  } catch (error) {
    if (error.status === 401) return showLogin();
    showNotice(error.message, true);
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice();
  const button = loginForm.querySelector('button');
  button.disabled = true;
  button.textContent = 'Unlocking…';
  try {
    await api('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: document.querySelector('#adminKey').value })
    });
    loginForm.reset();
    showDashboard();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Unlock dashboard';
  }
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice();
  uploadButton.disabled = true;
  uploadButton.textContent = 'Uploading privately…';
  try {
    const form = new FormData(uploadForm);
    form.set('madeForKids', document.querySelector('#madeForKids').checked ? 'true' : 'false');
    await api('/api/drafts', { method: 'POST', body: form });
    uploadForm.reset();
    showNotice('Private Short uploaded. Review it in the approval queue.');
    await loadDrafts();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    uploadButton.disabled = false;
    uploadButton.textContent = 'Upload as private draft';
  }
});

playlistForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  playlistCreateButton.disabled = true;
  playlistCreateButton.textContent = 'Creating playlist…';
  try {
    const form = Object.fromEntries(new FormData(playlistForm));
    const playlist = await api('/api/youtube/playlists', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form)
    });
    playlistForm.reset();
    showNotice('Created ' + playlist.privacyStatus + ' playlist: ' + playlist.title + '.');
    await loadPlaylists();
    await Promise.all([loadDrafts(), loadSeo()]);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    playlistCreateButton.disabled = false;
    playlistCreateButton.textContent = 'Create playlist';
  }
});
googleSearchImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = googleSearchImportForm.querySelector('button[type="submit"]');
  button.disabled = true;
  googleSearchImportStatus.textContent = 'Importing Search Console report…';
  try {
    const form = new FormData(googleSearchImportForm);
    const result = await api('/api/seo/google-search/import', { method: 'POST', body: form });
    googleSearchImportStatus.textContent =
      'Stored ' + result.savedCount + ' public video rows for ' + result.periodStart + '–' +
      result.periodEnd + '; ' + result.skippedCount +
      ' rows did not match public videos in this channel catalog.';
    googleSearchImportForm.reset();
    await loadSeo();
  } catch (error) {
    googleSearchImportStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

vodScanForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = vodScanForm.querySelector('button[type="submit"]');
  const vodId = String(new FormData(vodScanForm).get('vodId') || '').trim();
  if (!/^\d+$/.test(vodId)) {
    vodScanStatus.textContent = 'Enter a numeric Twitch VOD ID.';
    return;
  }
  submitButton.disabled = true;
  vodScanStatus.textContent = 'Checking the VOD and queuing eligible clips for screening…';
  try {
    const result = await api('/api/twitch/vod-clips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vodId })
    });
    const queued = Number(result.communityClipsQueued) || 0;
    vodScanStatus.textContent = result.message || (result.accepted
      ? `VOD scan ${result.status || 'accepted'}; ${queued} Twitch clip(s) queued for visual gameplay screening. Passing edits remain private for your review.`
      : 'No clips were queued. Amaana will retry when Twitch has more eligible footage.');
    if (result.accepted || queued > 0) await loadDrafts();
  } catch (error) {
    vodScanStatus.textContent = error.message || 'VOD scan failed.';
  } finally {
    submitButton.disabled = false;
  }
});

connectButton.addEventListener('click', () => window.location.assign('/auth/google'));
twitchConnectButton.addEventListener('click', () => window.location.assign('/auth/twitch'));
tiktokConnectButton.addEventListener('click', () => window.location.assign('/auth/tiktok'));
document.querySelector('#refreshButton').addEventListener('click', refreshDashboard);
document.querySelector('#seoRefresh').addEventListener('click', () => {
  loadSeo(); loadChannelSeo();
});
channelJaForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = channelJaForm.querySelector('button[type="submit"]');
  if (!channelLocalizationSnapshot?.id || !channelLocalizationSnapshot?.etag) {
    channelJaStatus.textContent = 'Refresh channel details before saving this translation.';
    return;
  }
  submitButton.disabled = true;
  channelJaStatus.textContent = 'Saving Japanese channel localization…';
  try {
    const result = await api('/api/seo/channel/localization/ja', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...channelLocalizationSnapshot,
        title: channelJaTitle.value, description: channelJaDescription.value })
    });
    await loadChannelSeo();
    showNotice(`Japanese channel localization saved. ${result.defaultLanguage || 'Existing'} remains the default channel language.`);
  } catch (error) {
    channelJaStatus.textContent = error.message;
    if (error.status === 401) showLogin();
  } finally {
    submitButton.disabled = false;
  }
});
jaAutopilotToggle.addEventListener('click', async () => {
  jaAutopilotToggle.disabled = true;
  const enabled = !japaneseAutopilotState?.enabled;
  try {
    await api('/api/seo/localization/ja/autopilot', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    await loadJapaneseAutopilotStatus();
    showNotice(enabled
      ? 'Japanese autopilot enabled. It will translate and save missing metadata automatically.'
      : 'Japanese autopilot paused.');
  } catch (error) {
    jaAutopilotStatus.textContent = error.message;
    showNotice(error.message, true);
    if (error.status === 401) showLogin();
  } finally {
    jaAutopilotToggle.disabled = false;
  }
});

seoToggle.addEventListener('click', async () => {
  seoToggle.disabled = true;
  try {
    await api('/api/seo/backfill', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !seoEnabled }) });
    await loadSeo();
  } catch (error) { showNotice(error.message, true); } finally { seoToggle.disabled = false; }
});
document.querySelector('#seoRescan').addEventListener('click', async () => {
  try {
    await api('/api/seo/backfill', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, restart: true }) });
    showNotice('Channel rescan started; existing packages are preserved.');
    await loadSeo();
  } catch (error) { showNotice(error.message, true); }
});
seoPlaylistAudit.addEventListener('click', async () => {
  seoPlaylistAudit.disabled = true;
  seoPlaylistAuditStatus.textContent = 'Reading channel uploads and playlist contents…';
  try {
    const report = await api('/api/seo/playlist-coverage/reconcile', { method: 'POST' });
    const scan = report.catalogScanComplete ? 'catalog scan complete' : 'catalog scan still running';
    const read = report.complete ? 'all playlists checked' : 'some playlists could not be read';
    const queued = report.requeuedCount || 0;
    seoPlaylistAuditStatus.textContent =
      `Playlist coverage: ${report.coveredCount}/${report.catalogCount} videos in any playlist; ${report.publicCoverageCount} in public playlists; ${report.missingCount} missing. ${queued} missing videos queued for repair; ${scan}; ${read}.`;
    showNotice(`Playlist audit checked ${report.catalogCount} channel videos across ${report.playlistCount} playlists. ${report.missingCount} videos lack playlist coverage; ${queued} previously assigned videos queued for repair. Unmatched videos remain unassigned for owner review.`);
    await loadSeo();
  } catch (error) {
    seoPlaylistAuditStatus.textContent = error.message;
    showNotice(error.message, true);
  } finally {
    seoPlaylistAudit.disabled = false;
  }
});
seoPrevious.addEventListener('click', () => { seoOffset = Math.max(0, seoOffset - 50); loadSeo(); });
seoNext.addEventListener('click', () => { seoOffset += 50; loadSeo(); });
document.querySelector('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
  showLogin();
});

(async () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('youtube') === 'connected') {
    history.replaceState({}, '', '/');
    showNotice('YouTube connected successfully.');
  }
  if (params.get('twitch') === 'connected') {
    history.replaceState({}, '', '/');
    showNotice('Twitch connected. Amaana will build a private 12-minute highlight only when enough game-category footage passes visual gameplay checks.');
  }
  if (params.get('tiktok') === 'connected') {
    history.replaceState({}, '', '/');
    showNotice('TikTok connected. Review a Short to send it to your TikTok inbox.');
  }
  try {
    const session = await api('/api/admin/session');
    if (session.authenticated) showDashboard();
    else showLogin();
  } catch (error) {
    showLogin();
    showNotice(error.message, true);
  }
})();

