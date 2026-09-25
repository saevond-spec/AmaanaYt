const loginView = document.querySelector('#loginView');
const dashboardView = document.querySelector('#dashboardView');
const loginForm = document.querySelector('#loginForm');
const uploadForm = document.querySelector('#uploadForm');
const notice = document.querySelector('#notice');
const connectionDot = document.querySelector('#connectionDot');
const connectionText = document.querySelector('#connectionText');
const connectionHelp = document.querySelector('#connectionHelp');
const connectButton = document.querySelector('#connectButton');
const draftList = document.querySelector('#draftList');
const uploadButton = document.querySelector('#uploadButton');

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
  loginView.classList.remove('hidden');
  dashboardView.classList.add('hidden');
}

function showDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  refreshDashboard();
}

async function refreshConnection() {
  const status = await api('/api/youtube/status');
  connectionDot.classList.toggle('connected', status.connected);
  connectionText.textContent = status.connected ? 'Connected' : 'Not connected';
  connectionHelp.textContent = status.connected
    ? 'Amaana can upload private Shorts to your authorized channel.'
    : 'Connect the Google account that owns @saevond.';
  connectButton.textContent = status.connected ? 'Reconnect YouTube' : 'Connect YouTube';
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

function renderDraft(draft) {
  const card = element('article', 'draft');
  const top = element('div', 'draft-top');
  top.append(element('h3', '', draft.title || 'Untitled Short'));
  top.append(element('span', 'draft-status', String(draft.status || 'unknown').replaceAll('_', ' ')));
  card.append(top);

  const created = draft.createdAt ? new Date(draft.createdAt).toLocaleString() : 'Unknown date';
  card.append(element('p', 'draft-meta', `Created ${created}`));

  if (draft.youtubeUrl) {
    const link = element('a', 'ghost video-link');
    link.href = draft.youtubeUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open on YouTube';
    card.append(link);
  }

  if (draft.status === 'awaiting_owner_approval') {
    const actions = element('div', 'draft-actions');
    const publish = element('button', 'publish', 'Publish now');
    publish.type = 'button';
    publish.addEventListener('click', () => {
      if (window.confirm('Publish this Short publicly now?')) approveDraft(draft.id, null, publish);
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
  return card;
}

async function loadDrafts() {
  try {
    const drafts = await api('/api/drafts');
    draftList.replaceChildren();
    if (!drafts.length) {
      draftList.append(element('div', 'empty-state', 'No drafts yet. Upload a Short above or let your agent create one.'));
      return;
    }
    drafts.forEach((draft) => draftList.append(renderDraft(draft)));
  } catch (error) {
    if (error.status === 401) return showLogin();
    draftList.replaceChildren(element('div', 'empty-state', error.message));
  }
}

async function refreshDashboard() {
  try {
    await Promise.all([refreshConnection(), loadDrafts()]);
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

connectButton.addEventListener('click', () => window.location.assign('/auth/google'));
document.querySelector('#refreshButton').addEventListener('click', refreshDashboard);
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
  try {
    const session = await api('/api/admin/session');
    if (session.authenticated) showDashboard();
    else showLogin();
  } catch (error) {
    showLogin();
    showNotice(error.message, true);
  }
})();
