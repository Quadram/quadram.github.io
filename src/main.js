'use strict';

// ═══════════════════════════════════════════════════════════════════
// ⚠  CONFIG — update these values to match your GitHub setup
// ═══════════════════════════════════════════════════════════════════
const CONFIG = {
  org:    'quadramqs',          // GitHub organization name
  owner:  'Quadram',          // Repo owner (org name or username)
  repo:   'translations-editor',    // Repository name
  file:   'translations.json',      // Path to the translations file in the repo
  branch: 'main',                   // Branch to read/write
};

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
const state = {
  pat: null,
  user: null,            // { login, name }
  translations: [],      // Array<{ key: string, text: { en, fr, de } }>
  sha: null,             // Current file SHA (needed for updates)
  hasUnsavedChanges: false,
  pendingDeleteKey: null,
  filterQuery: '',
  sortAlpha: true,
};

// Editing state
let _editingKey = null;  // null = adding, string = editing

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // Display org name in login subtitle
  document.getElementById('org-name-display').textContent = CONFIG.org;
  document.getElementById('nav-repo-label').textContent = `${CONFIG.owner}/${CONFIG.repo}`;

  // Restore saved session
  const savedPat  = localStorage.getItem('gh_pat');
  const savedUser = localStorage.getItem('gh_user');
  if (savedPat && savedUser) {
    try {
      state.pat  = savedPat;
      state.user = JSON.parse(savedUser);
      showApp();
      void loadTranslations();
    } catch {
      localStorage.removeItem('gh_pat');
      localStorage.removeItem('gh_user');
    }
  }

  // Enter key triggers login
  document.getElementById('pat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') void handleLogin();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (state.pat) void handleSave();
    }
    if (e.key === 'Escape') {
      closeModal();
      closeDeleteModal();
    }
  });

  // Close modals when clicking the backdrop
  document.getElementById('entry-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('entry-overlay')) closeModal();
  });
  document.getElementById('delete-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('delete-overlay')) closeDeleteModal();
  });

  // Warn before closing with unsaved changes
  window.addEventListener('beforeunload', e => {
    if (state.hasUnsavedChanges) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// GITHUB API HELPERS
// ═══════════════════════════════════════════════════════════════════
function ghHeaders() {
  return {
    'Authorization': `token ${state.pat}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubGet(path) {
  return fetch(`https://api.github.com${path}`, { headers: ghHeaders() });
}

async function githubPut(path, body) {
  return fetch(`https://api.github.com${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ═══════════════════════════════════════════════════════════════════
// AUTH
// ════���══════════════════════════════════════════════════════════════
async function login(pat) {
  // Step 1 — verify token & get username
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `token ${pat}`,
      'Accept': 'application/vnd.github+json',
    },
  });

  if (userRes.status === 401) throw new Error('Invalid token — please check your PAT and try again.');
  if (!userRes.ok) throw new Error(`GitHub API error: ${userRes.status} ${userRes.statusText}`);

  const { login: username, name } = await userRes.json();

  // Step 2 — verify org membership
  const orgRes = await fetch(
    `https://api.github.com/orgs/${CONFIG.org}/members/${username}`,
    {
      headers: {
        'Authorization': `token ${pat}`,
        'Accept': 'application/vnd.github+json',
      },
    },
  );

  if (orgRes.status === 302) {
    throw new Error(
      'Access denied — your org membership appears to be private. ' +
      'Make sure your PAT includes "Organization permissions → Members: Read-only".'
    );
  }
  if (orgRes.status === 401 || orgRes.status === 403) {
    throw new Error(
      'Access denied — token is missing the "Members: Read-only" permission. ' +
      'Regenerate your PAT with the correct scopes.'
    );
  }
  if (orgRes.status !== 204) {
    throw new Error(`Access denied — @${username} is not a member of the "${CONFIG.org}" organization.`);
  }

  // Step 3 — store session
  state.pat  = pat;
  state.user = { login: username, name };
  localStorage.setItem('gh_pat', pat);
  localStorage.setItem('gh_user', JSON.stringify(state.user));
}

// ═══════════════════════════════════════════════════════════════════
// TRANSLATIONS I/O
// ═══════════════════════════════════════════════════════════════════
async function loadTranslations() {
  setLoading(true);
  try {
    const res = await githubGet(
      `/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.file}`
    );

    if (res.status === 404) {
      state.translations = [];
      state.sha = null;
      renderTable();
      showToast('info', 'Empty file', `${CONFIG.file} not found in the repo. It will be created on first save.`);
      return;
    }
    if (!res.ok) throw new Error(`Failed to load: ${res.status} ${res.statusText}`);

    const data = await res.json();
    state.sha = data.sha;
    // Decode base64 → UTF-8 bytes → string (supports ä ö ü é à ç etc.)
    const rawBytes = Uint8Array.from(
      atob(data.content.replace(/\s/g, '')),
      c => c.charCodeAt(0)
    );
    const parsed = JSON.parse(new TextDecoder().decode(rawBytes));

    // Support both the new wrapper format { date, string: [] } and the legacy flat array
    if (Array.isArray(parsed)) {
      state.translations = parsed;
    } else if (parsed && Array.isArray(parsed.string)) {
      state.translations = parsed.string;
    } else {
      throw new Error(`${CONFIG.file} has an unexpected format. Expected an object with a "string" array.`);
    }

    renderTable();
  } catch (err) {
    showToast('error', 'Load failed', err.message, 0);
  } finally {
    setLoading(false);
  }
}

async function saveTranslations(commitMessage) {
  // Always fetch the latest SHA before writing to prevent conflicts
  let currentSha = null;
  const getRes = await githubGet(
    `/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.file}`
  );
  if (getRes.ok) {
    const current = await getRes.json();
    currentSha = current.sha;
  }

  const data = state.sortAlpha
    ? [...state.translations].sort((a, b) => a.key.localeCompare(b.key))
    : [...state.translations];

  // Wrap with a top-level date stamp for versioning
  const wrapper = { date: new Date().toISOString(), strings: data };

  // Encode JSON → UTF-8 bytes → base64 (handles ä ö ü é à ç etc.)
  const jsonStr = JSON.stringify(wrapper, null, 2);
  const utf8Bytes = new TextEncoder().encode(jsonStr);
  let binary = '';
  for (let i = 0; i < utf8Bytes.length; i++) binary += String.fromCharCode(utf8Bytes[i]);
  const content = btoa(binary);

  const body = { message: commitMessage, content, branch: CONFIG.branch };
  if (currentSha) body.sha = currentSha;

  const putRes = await githubPut(
    `/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.file}`,
    body
  );

  if (!putRes.ok) {
    const errBody = await putRes.json().catch(() => ({}));
    throw new Error(errBody.message || `Save failed: ${putRes.status}`);
  }

  const result = await putRes.json();
  state.sha = result.content.sha;
  state.translations = data;
  setUnsaved(false);
  return result.commit.sha;
}

// ═══════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════
async function handleLogin() {
  const pat = document.getElementById('pat-input').value.trim();
  if (!pat) return;

  const btn   = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Connecting…';

  try {
    await login(pat);
    showApp();
    await loadTranslations();
  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = 'block';
    btn.disabled        = false;
    btn.textContent     = 'Connect';
  }
}

function handleLogout() {
  if (state.hasUnsavedChanges) {
    if (!confirm('You have unsaved changes. Logout anyway?')) return;
  }
  state.pat  = null;
  state.user = null;
  state.translations = [];
  state.sha  = null;
  setUnsaved(false);
  localStorage.removeItem('gh_pat');
  localStorage.removeItem('gh_user');
  hideApp();
}

function handleSearch(query) {
  state.filterQuery = query.toLowerCase();
  renderTable();
}

function handleSortToggle(checked) {
  state.sortAlpha = checked;
  renderTable();
}

async function handleSave() {
  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';

  try {
    const sha = await saveTranslations(
      `Update translations via editor · @${state.user.login}`
    );
    renderTable();
    showToast('success', 'Saved!', `Committed as ${sha.slice(0, 7)}`);
  } catch (err) {
    showToast('error', 'Save failed', err.message, 0);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
        <path d="M2 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H9.5a1 1 0 0 0-1 1v7.293l2.646-2.647a.5.5 0 0 1 .708.708l-3.5 3.5a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L7.5 9.293V2a2 2 0 0 1 2-2H14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h2.5a.5.5 0 0 1 0 1H2z"/>
      </svg>
      Save to GitHub`;
  }
}

async function handleRefresh() {
  if (state.hasUnsavedChanges) {
    if (!confirm('Refreshing will discard your unsaved changes. Continue?')) return;
    setUnsaved(false);
  }
  await loadTranslations();
  showToast('info', 'Refreshed', 'Translations reloaded from GitHub.');
}

function handleExport() {
  const json = JSON.stringify(state.translations, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: CONFIG.file });
  a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════════
// ADD / EDIT MODAL
// ═══════════════════════════════════════════════════════════════════
function openModal(key) {
  _editingKey = key;
  const isEdit = key !== null;

  document.getElementById('modal-title').textContent    = isEdit ? 'Edit Entry' : 'Add Entry';
  document.getElementById('modal-save-btn').textContent = isEdit ? 'Update Entry' : 'Save Entry';

  // Clear validation messages
  ['key-error', 'en-warn', 'fr-warn', 'de-warn'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });

  const keyInput = document.getElementById('modal-key');

  if (isEdit) {
    const entry = state.translations.find(t => t.key === key);
    if (!entry) return;
    keyInput.value    = entry.key;
    keyInput.disabled = true;   // key is immutable when editing
    document.getElementById('modal-en').value = entry.text.en || '';
    document.getElementById('modal-fr').value = entry.text.fr || '';
    document.getElementById('modal-de').value = entry.text.de || '';
  } else {
    keyInput.value    = '';
    keyInput.disabled = false;
    document.getElementById('modal-en').value = '';
    document.getElementById('modal-fr').value = '';
    document.getElementById('modal-de').value = '';
  }

  document.getElementById('entry-overlay').classList.add('open');
  setTimeout(() => (isEdit ? document.getElementById('modal-en') : keyInput).focus(), 60);
}

function closeModal() {
  document.getElementById('entry-overlay').classList.remove('open');
  _editingKey = null;
}

function handleKeyInput(input) {
  const pos = input.selectionStart;
  input.value = input.value.toUpperCase();
  input.setSelectionRange(pos, pos);
  validateKeyInput(input.value);
}

function validateKeyInput(val) {
  const errEl = document.getElementById('key-error');
  if (!val) { errEl.style.display = 'none'; return true; }
  if (/\s/.test(val)) {
    errEl.textContent   = '✕ No spaces allowed in the key';
    errEl.style.display = 'block';
    return false;
  }
  if (_editingKey === null && state.translations.some(t => t.key === val)) {
    errEl.textContent   = '✕ A key with this name already exists';
    errEl.style.display = 'block';
    return false;
  }
  errEl.style.display = 'none';
  return true;
}

function checkEmpty(warnId, val) {
  document.getElementById(warnId).style.display = val.trim() ? 'none' : 'block';
}

function handleModalSave() {
  const keyEl = document.getElementById('modal-key');
  const key   = keyEl.value.trim();
  const en    = document.getElementById('modal-en').value;
  const fr    = document.getElementById('modal-fr').value;
  const de    = document.getElementById('modal-de').value;

  if (!key) {
    const errEl = document.getElementById('key-error');
    errEl.textContent   = '✕ Key is required';
    errEl.style.display = 'block';
    keyEl.focus();
    return;
  }
  if (!validateKeyInput(key)) { keyEl.focus(); return; }

  // Show warnings for empty language fields (non-blocking)
  checkEmpty('en-warn', en);
  checkEmpty('fr-warn', fr);
  checkEmpty('de-warn', de);

  if (_editingKey !== null) {
    const idx = state.translations.findIndex(t => t.key === _editingKey);
    if (idx !== -1) state.translations[idx] = { key, text: { en, fr, de } };
  } else {
    state.translations.push({ key, text: { en, fr, de } });
  }

  setUnsaved(true);
  renderTable();
  closeModal();
  showToast('info', _editingKey ? 'Entry updated' : 'Entry added', `"${key}" — remember to Save to GitHub.`);
}

// ═══════════════════════════════════════════════════════════════════
// DELETE MODAL
// ═══════════════════════════════════════════════════════════════════
function openDeleteModal(key) {
  state.pendingDeleteKey = key;
  document.getElementById('delete-key-display').textContent = key;
  document.getElementById('delete-overlay').classList.add('open');
}

function closeDeleteModal() {
  document.getElementById('delete-overlay').classList.remove('open');
  state.pendingDeleteKey = null;
}

function confirmDelete() {
  const key = state.pendingDeleteKey;
  if (!key) return;
  state.translations = state.translations.filter(t => t.key !== key);
  setUnsaved(true);
  renderTable();
  closeDeleteModal();
  showToast('warning', 'Entry deleted', `"${key}" removed locally — Save to GitHub to commit.`);
}

// ═══════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════
function renderTable() {
  const tbody    = document.getElementById('table-body');
  const emptyEl  = document.getElementById('empty-state');
  const countBar = document.getElementById('count-bar');

  let entries = [...state.translations];

  if (state.sortAlpha) {
    entries.sort((a, b) => a.key.localeCompare(b.key));
  }

  const total = entries.length;
  const query = state.filterQuery;

  if (query) {
    entries = entries.filter(e =>
      e.key.toLowerCase().includes(query) ||
      (e.text.en || '').toLowerCase().includes(query) ||
      (e.text.fr || '').toLowerCase().includes(query) ||
      (e.text.de || '').toLowerCase().includes(query)
    );
  }

  if (entries.length === 0) {
    tbody.innerHTML = '';
    emptyEl.style.display = 'block';
    if (query) {
      document.getElementById('empty-title').textContent = 'No results';
      document.getElementById('empty-sub').innerHTML =
        `No entries match "<strong>${esc(query)}</strong>".`;
    } else {
      document.getElementById('empty-title').textContent = 'No entries yet';
      document.getElementById('empty-sub').textContent =
        'Click "Add Entry" to create your first translation key.';
    }
    countBar.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';

  tbody.innerHTML = entries.map(e => `
    <tr>
      <td class="key-cell">${esc(e.key)}</td>
      <td class="text-cell${e.text.en ? '' : ' empty'}">${e.text.en ? esc(e.text.en) : '<em>empty</em>'}</td>
      <td class="text-cell${e.text.fr ? '' : ' empty'}">${e.text.fr ? esc(e.text.fr) : '<em>empty</em>'}</td>
      <td class="text-cell${e.text.de ? '' : ' empty'}">${e.text.de ? esc(e.text.de) : '<em>empty</em>'}</td>
      <td class="actions-cell">
        <button class="icon-btn" title="Edit" data-key="${esc(e.key)}" onclick="openModal(this.dataset.key)">
          <svg width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
            <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/>
          </svg>
        </button>
        <button class="icon-btn del" title="Delete" data-key="${esc(e.key)}" onclick="openDeleteModal(this.dataset.key)">
          <svg width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
            <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
            <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
          </svg>
        </button>
      </td>
    </tr>
  `).join('');

  countBar.style.display = 'block';
  countBar.textContent = query
    ? `Showing ${entries.length} of ${total} entr${total === 1 ? 'y' : 'ies'}`
    : `${total} entr${total === 1 ? 'y' : 'ies'}`;
}

// ═══════════════════════════════════════════════════════════════════
// UI STATE HELPERS
// ═══════════════════════════════════════════════════════════════════
function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('navbar').style.display       = 'flex';
  document.getElementById('toolbar').style.display      = 'flex';
  document.getElementById('table-wrap').style.display   = 'block';
  document.getElementById('count-bar').style.display    = 'block';
  document.getElementById('nav-username').textContent   = `@${state.user.login}`;
}

function hideApp() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('navbar').style.display       = 'none';
  document.getElementById('toolbar').style.display      = 'none';
  document.getElementById('table-wrap').style.display   = 'none';
  document.getElementById('count-bar').style.display    = 'none';
  document.getElementById('pat-input').value            = '';
  document.getElementById('login-btn').textContent      = 'Connect';
  document.getElementById('login-error').style.display  = 'none';
}

function setUnsaved(val) {
  state.hasUnsavedChanges = val;
  document.getElementById('unsaved-badge').style.display = val ? 'inline-block' : 'none';
}

function setLoading(on) {
  const btn = document.getElementById('save-btn');
  if (btn) btn.disabled = on;
}

// ═══════════════════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════
function showToast(type, title, message = '', duration = 5000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-content">
      <div class="toast-title">${esc(title)}</div>
      ${message ? `<div class="toast-msg">${esc(message)}</div>` : ''}
    </div>
    <button class="icon-btn toast-close" onclick="this.closest('.toast').remove()" aria-label="Dismiss">
      <svg width="11" height="11" fill="currentColor" viewBox="0 0 16 16">
        <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
      </svg>
    </button>
  `;
  container.appendChild(toast);
  if (duration > 0) setTimeout(() => toast.remove(), duration);
}

// ═══════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
