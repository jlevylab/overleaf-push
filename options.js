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

// --- projects, and where each one goes -------------------------------------
async function render(projects) {
  const ids = Object.keys(projects);
  if (!ids.length) {
    $('projects').textContent = 'None yet. Open a project in Overleaf and it appears here.';
    return;
  }
  const { routes = {} } = await chrome.storage.local.get('routes');
  const rows = ids
    .sort((a, b) => (projects[b].seen || '').localeCompare(projects[a].seen || ''))
    .map(id => {
      const p = projects[id];
      const r = routes[id] || {};
      const routed = !!(r.owner && r.repo);
      return `<tr data-id="${id}" class="prow">
        <td class="pname">${escapeHtml(p.name || '(unnamed)')}<br>
          <a href="https://www.overleaf.com/project/${id}" target="_blank"><code>${id}</code></a></td>
        <td>
          <input class="r-owner"  placeholder="owner  (blank = mirror)" value="${escapeHtml(r.owner || '')}">
          <input class="r-repo"   placeholder="repository"              value="${escapeHtml(r.repo || '')}">
          <input class="r-branch" placeholder="main"                    value="${escapeHtml(r.branch || '')}">
          <input class="r-path"   placeholder="path in repo (blank = root)" value="${escapeHtml(r.path || '')}">
          <label style="font-weight:400;margin:2px 0 0"><input type="checkbox" class="r-mirror" style="width:auto" ${r.mirror ? 'checked' : ''}> force to mirror</label>
        </td>
        <td class="pgo">
          <button class="quiet r-save">Save</button>
          <button class="quiet r-test">Test</button>
          <div class="r-state">${routed
            ? `&rarr; ${escapeHtml(r.owner)}/${escapeHtml(r.repo)}`
            : (r.mirror ? '&rarr; mirror (forced)' : '&rarr; auto')}</div>
        </td></tr>`;
    })
    .join('');
  $('projects').innerHTML =
    `<table class="ptable"><tbody>${rows}</tbody></table>`;

  for (const row of document.querySelectorAll('tr.prow')) {
    const id = row.dataset.id;
    const read = () => ({
      owner: row.querySelector('.r-owner').value.trim(),
      repo: row.querySelector('.r-repo').value.trim(),
      branch: row.querySelector('.r-branch').value.trim() || 'main',
      path: row.querySelector('.r-path').value.trim(),
      mirror: row.querySelector('.r-mirror').checked,
    });

    row.querySelector('.r-save').addEventListener('click', async () => {
      const r = read();
      const { routes = {} } = await chrome.storage.local.get('routes');
      if (r.mirror) {
        routes[id] = { mirror: true };
        row.querySelector('.r-state').innerHTML = '&rarr; mirror (forced)';
      } else if (!r.owner || !r.repo) {
        delete routes[id];
        row.querySelector('.r-state').innerHTML = '&rarr; auto';
      } else {
        routes[id] = r;
        row.querySelector('.r-state').innerHTML = `&rarr; ${escapeHtml(r.owner)}/${escapeHtml(r.repo)}`;
      }
      await chrome.storage.local.set({ routes });
      say($('routeMsg'), 'Saved.', 'ok');
    });

    row.querySelector('.r-test').addEventListener('click', async () => {
      const r = read();
      if (!r.owner || !r.repo) { say($('routeMsg'), 'This project goes to the mirror.', 'ok'); return; }
      say($('routeMsg'), `checking ${r.owner}/${r.repo}...`);
      const { token } = await chrome.storage.local.get('token');
      if (!token) { say($('routeMsg'), 'Connect to GitHub first.', 'bad'); return; }
      try {
        const res = await fetch(`https://api.github.com/repos/${r.owner}/${r.repo}/branches/${r.branch}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        });
        if (res.ok) {
          say($('routeMsg'), `${r.owner}/${r.repo} on ${r.branch} is reachable.`, 'ok');
        } else if (res.status === 404 || res.status === 403) {
          say($('routeMsg'),
            `Cannot reach ${r.owner}/${r.repo}. The app is installed on some repositories only. `
            + 'Add this one at github.com/settings/installations, then test again.', 'bad');
        } else {
          say($('routeMsg'), `GitHub said ${res.status}.`, 'bad');
        }
      } catch (e) {
        say($('routeMsg'), String(e.message || e), 'bad');
      }
    });
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}


// --- repositories the token can write to -----------------------------------
async function repoCount(fresh) {
  const el = $('repoCount');
  if (!el) return;
  el.textContent = fresh ? ' rescanning...' : '';
  const res = await chrome.runtime.sendMessage({ type: 'repos', fresh: !!fresh });
  if (res && res.ok) {
    el.textContent = ` ${res.repos.length} repositories reachable; a project is matched to one by name.`;
  } else if (res) {
    el.textContent = ` ${res.error}`;
  }
}

if ($('rescan')) {
  $('rescan').addEventListener('click', () => repoCount(true));
  repoCount(false);
}
