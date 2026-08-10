const $ = id => document.getElementById(id);

let cancelling = false;

chrome.storage.local.get(
  ['token', 'owner', 'repo', 'branch', 'projects', 'auth', 'clientId', 'scope']
).then(s => {
  $('token').value = s.token || '';
  $('owner').value = s.owner || 'levylabpitt';
  $('repo').value = s.repo || 'overleaf';
  $('branch').value = s.branch || 'main';
  $('clientId').value = s.clientId || OLPUSH_CLIENT_ID || '';
  $('scope').value = s.scope !== undefined ? s.scope : OLPUSH_SCOPE;
  render(s.projects || {});
  showAuth(s);
});

function say(el, text, cls = '') {
  el.className = cls;
  el.textContent = text;
}

// Deliberately not called `clientId` / `scope`: those ids are already on window
// as the input elements themselves.
const currentClientId = () => ($('clientId').value.trim() || OLPUSH_CLIENT_ID || '');
const currentScope = () => ($('scope').value.trim() || '');

// --- connection state ------------------------------------------------------
function showAuth(s) {
  const connected = !!s.token;
  $('disconnect').hidden = !connected;
  $('connect').textContent = connected ? 'Reconnect' : 'Connect GitHub';

  if (!connected) {
    $('authState').textContent = currentClientId()
      ? 'Not connected.'
      : 'Not connected, and no Client ID is set. Register the app once (see README.md), then paste its Client ID under Advanced.';
    return;
  }

  const a = s.auth || {};
  const who = a.login ? `Connected as ${a.login}` : 'Connected with a token you pasted';
  const reach = a.scopes
    ? ` (scopes: ${a.scopes})`
    : a.login ? ' (reach limited to where the app is installed)' : '';
  $('authState').innerHTML = `<span class="who"></span>`;
  $('authState').firstChild.textContent = who + reach;

  // An expiring token is the one thing that would drag you back here in eight
  // hours, so name it rather than letting it just stop working.
  if (a.expiresIn) {
    const note = document.createElement('div');
    note.className = 'warn';
    note.textContent = 'This app issues expiring tokens, so you will have to reconnect. '
      + 'Untick "Expire user authorization tokens" in the app settings to stop that.';
    $('authState').appendChild(note);
  }
}

$('connect').addEventListener('click', async () => {
  cancelling = false;
  $('connect').disabled = true;
  $('device').hidden = false;
  say($('authMsg'), 'asking GitHub for a code...');

  try {
    const result = await deviceConnect(
      { clientId: currentClientId(), scope: currentScope() },
      {
        code: d => {
          $('userCode').textContent = d.user_code;
          $('openGitHub').dataset.url = d.verification_uri || 'https://github.com/login/device';
          say($('authMsg'), 'waiting for you to enter it on github.com...');
        },
        wait: secs => {
          $('countdown').textContent = `code valid for ${Math.floor(secs / 60)}m ${secs % 60}s`;
        },
        cancelled: () => cancelling,
      });

    await chrome.storage.local.set({
      token: result.token,
      auth: {
        login: result.login,
        scopes: result.scopes,
        expiresIn: result.expiresIn,
        obtained: result.obtained,
      },
    });
    $('token').value = result.token;
    $('device').hidden = true;
    showAuth(await chrome.storage.local.get(['token', 'auth']));
    say($('authMsg'), 'Connected. Checking the repo...', 'ok');
    await checkRepo($('authMsg'));
  } catch (e) {
    $('device').hidden = true;
    const m = String(e.message || e);
    say($('authMsg'), m === 'cancelled' ? 'Cancelled.' : m, m === 'cancelled' ? '' : 'bad');
  } finally {
    $('connect').disabled = false;
    $('countdown').textContent = '';
  }
});

$('cancel').addEventListener('click', () => { cancelling = true; });

$('copyCode').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('userCode').textContent);
    $('copyCode').textContent = 'Copied';
    setTimeout(() => { $('copyCode').textContent = 'Copy code'; }, 2000);
  } catch (_) {
    say($('authMsg'), 'Could not reach the clipboard. Type the code by hand.', 'warn');
  }
});

$('openGitHub').addEventListener('click', () => {
  chrome.tabs.create({ url: $('openGitHub').dataset.url || 'https://github.com/login/device' });
});

$('disconnect').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token', 'auth']);
  $('token').value = '';
  showAuth({});
  say($('authMsg'), 'Disconnected. The token is gone from this machine.');
});

// --- the repo it writes to -------------------------------------------------
async function checkRepo(msgEl) {
  const s = await chrome.storage.local.get('token');
  const owner = $('owner').value.trim();
  const repo = $('repo').value.trim();
  const branch = $('branch').value.trim() || 'main';

  if (!s.token) { say(msgEl, 'Connect to GitHub first.', 'bad'); return false; }
  if (!owner || !repo) { say(msgEl, 'Owner and repository are both required.', 'bad'); return false; }

  try {
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      { headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' } });
    if (r.ok) { say(msgEl, `Reachable: ${owner}/${repo} on ${branch}.`, 'ok'); return true; }

    const a = (await chrome.storage.local.get('auth')).auth || {};
    if (r.status === 404 && a.login && !a.scopes) {
      // A GitHub App token that cannot see the repo almost always means the app
      // was never installed on it, which is a different fix from a wrong name.
      say(msgEl, `Cannot see ${owner}/${repo} on ${branch}. If the name is right, the app is not `
        + 'installed on that repository yet: install it from its page on github.com.', 'bad');
    } else if (r.status === 404) {
      say(msgEl, `Cannot see ${owner}/${repo} on ${branch}. Check the name, the branch, and that `
        + 'the token grants this repo.', 'bad');
    } else if (r.status === 401) {
      say(msgEl, 'GitHub rejected the token. Press Connect to get a fresh one.', 'bad');
    } else {
      say(msgEl, `GitHub said ${r.status}. Check the token's permissions.`, 'bad');
    }
    return false;
  } catch (e) {
    say(msgEl, String(e.message || e), 'bad');
    return false;
  }
}

$('save').addEventListener('click', async () => {
  const cfg = {
    owner: $('owner').value.trim(),
    repo: $('repo').value.trim(),
    branch: $('branch').value.trim() || 'main',
  };
  if (!cfg.owner || !cfg.repo) {
    say($('msg'), 'Owner and repository are both required.', 'bad');
    return;
  }
  await chrome.storage.local.set(cfg);
  say($('msg'), 'checking the repo...');
  await checkRepo($('msg'));
});

$('saveToken').addEventListener('click', async () => {
  const token = $('token').value.trim();
  if (!token) { say($('authMsg'), 'Paste a token first.', 'bad'); return; }
  await chrome.storage.local.set({ token, auth: { login: null, scopes: null } });
  showAuth({ token, auth: {} });
  say($('authMsg'), 'Saved. Checking the repo...');
  await checkRepo($('authMsg'));
});

$('saveAdvanced').addEventListener('click', async () => {
  await chrome.storage.local.set({ clientId: $('clientId').value.trim(), scope: currentScope() });
  showAuth(await chrome.storage.local.get(['token', 'auth']));
  say($('authMsg'), 'Saved.', 'ok');
});

// --- projects seen ---------------------------------------------------------
function render(projects) {
  const ids = Object.keys(projects);
  if (!ids.length) {
    $('projects').textContent = 'None yet. Open a project in Overleaf and it appears here.';
    return;
  }
  const rows = ids
    .sort((a, b) => (projects[b].seen || '').localeCompare(projects[a].seen || ''))
    .map(id => {
      const p = projects[id];
      return `<tr><td style="padding:2px 12px 2px 0">${escapeHtml(p.name || '(unnamed)')}</td>
              <td style="padding:2px 0"><a href="https://www.overleaf.com/project/${id}"
              target="_blank"><code>${id}</code></a></td></tr>`;
    })
    .join('');
  $('projects').innerHTML = `<table>${rows}</table>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
