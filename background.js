// Service worker: does the work the page cannot.
//
// Overleaf auth is just the browser session, so fetching the project zip needs
// no token at all. The only secret in this extension is the GitHub token, which
// the options page obtains through the device flow (see auth.js) and leaves in
// extension storage. Getting that token is not this file's job: a service worker
// is stopped while idle and cannot sit through a fifteen-minute authorization.

const GH = 'https://api.github.com';

async function settings() {
  const s = await chrome.storage.local.get(['token', 'owner', 'repo', 'branch']);
  if (!s.token) throw new Error('Not connected to GitHub. Open the extension options and press Connect.');
  if (!s.owner || !s.repo) throw new Error('No target repo set. Open the extension options.');
  return { branch: 'main', ...s };
}

// Where a given project goes.
//
// A project with a repo of its own should push there, at the repo root, so that
// pressing the button in Overleaf updates the real project rather than a backup
// nobody reads. Anything else falls back to the shared mirror, one repo with
// every project under overleaf/<id>/, which needs no setup at all.
//
// Which repo is which is worked out below without asking the user, because
// asking per project does not scale to hundreds of them.

// Every repository the token can actually write to.
//
// A GitHub App token answers this directly: /installation/repositories is the
// list of repos the app was installed on, which is exactly the set of possible
// targets. A classic OAuth token has no such endpoint, so fall back to /user/repos.
// Cached, because it changes about as often as someone installs an app.
const REPO_TTL = 60 * 60 * 1000;

async function accessibleRepos(cfg, { fresh = false } = {}) {
  const { repoCache } = await chrome.storage.local.get('repoCache');
  if (!fresh && repoCache && Date.now() - repoCache.at < REPO_TTL) return repoCache.repos;

  const repos = [];
  for (const path of ['/installation/repositories?per_page=100', '/user/repos?per_page=100&sort=pushed']) {
    try {
      let page = 1;
      for (;;) {
        const url = path.includes('installation')
          ? `/installation/repositories?per_page=100&page=${page}`
          : `/user/repos?per_page=100&sort=pushed&page=${page}`;
        const r = await gh(url, {}, cfg);
        const batch = Array.isArray(r) ? r : (r.repositories || []);
        for (const x of batch) {
          repos.push({
            owner: x.owner.login, name: x.name,
            branch: x.default_branch || 'main',
            empty: x.size === 0,
          });
        }
        if (batch.length < 100) break;
        if (++page > 10) break;
      }
      if (repos.length) break;      // the first endpoint that answers wins
    } catch (_) { /* try the next shape */ }
  }
  await chrome.storage.local.set({ repoCache: { at: Date.now(), repos } });
  return repos;
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Overleaf cannot say which repo a project belongs to: for a project made by a
// one-time import it holds no link at all, and its API knows only about projects
// using Overleaf's own GitHub sync. So ask GitHub instead. If exactly one
// reachable repository has the project's name, that is the answer, and no
// per-project setup is needed.
async function discover(projectName, cfg) {
  if (!projectName) return null;
  const want = slug(projectName);
  if (!want) return null;
  const repos = await accessibleRepos(cfg);
  const hits = repos.filter(r => slug(r.name) === want && !r.empty);
  if (hits.length !== 1) return null;                 // ambiguous or absent: do nothing
  if (slug(hits[0].name) === slug(cfg.repo)) return null;   // that is the mirror itself
  return hits[0];
}

async function routeFor(projectId, cfg, projectName) {
  const { routes = {} } = await chrome.storage.local.get('routes');
  const r = routes[projectId];

  // An explicit route always wins, including one that says "use the mirror".
  if (r && r.mirror) {
    return { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch,
             base: `overleaf/${projectId}`, routed: false, why: 'set by hand' };
  }
  if (r && r.owner && r.repo) {
    return {
      owner: r.owner,
      repo: r.repo,
      branch: r.branch || 'main',
      base: (r.path || '').replace(/^\/+|\/+$/g, ''),   // '' means the repo root
      routed: true,
      why: 'set by hand',
    };
  }

  const found = await discover(projectName, cfg);
  if (found) {
    return { owner: found.owner, repo: found.name, branch: found.branch,
             base: '', routed: true, why: 'matched by name' };
  }

  return {
    owner: cfg.owner,
    repo: cfg.repo,
    branch: cfg.branch,
    base: `overleaf/${projectId}`,
    routed: false,
    why: 'no repository of this name',
  };
}

// A route that points somewhere the token cannot write fails deep inside the
// commit, with a 404 that reads like a typo. Say the real thing instead.
async function assertWritable(dest, cfg) {
  const r = await fetch(`${GH}/repos/${dest.owner}/${dest.repo}`, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (r.status === 404 || r.status === 403) {
    throw new Error(
      `The GitHub token cannot reach ${dest.owner}/${dest.repo}. `
      + `The app is installed on some repositories only. Install it on this one at `
      + `https://github.com/settings/installations (or the organisation's Settings, `
      + `Applications), then press the button again.`);
  }
  if (!r.ok) throw new Error(`GitHub ${r.status} checking ${dest.owner}/${dest.repo}`);
  const info = await r.json();
  if (info.permissions && info.permissions.push === false) {
    throw new Error(`The token can read ${dest.owner}/${dest.repo} but not write to it. `
      + 'Give the app Contents: read and write on that repository.');
  }
  return info;
}

async function gh(path, opts = {}, cfg) {
  const r = await fetch(GH + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });
  if (!r.ok) {
    // A dead token is the one failure with an obvious next step, and the raw
    // body ("Bad credentials") does not suggest it.
    if (r.status === 401) {
      throw new Error('GitHub rejected the token. Open the extension options and press Connect.');
    }
    const body = await r.text();
    throw new Error(`GitHub ${r.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return r.status === 204 ? null : r.json();
}

// --- zip reading, using the platform's own inflate ------------------------
async function unzip(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  const floor = Math.max(0, buf.byteLength - 22 - 65536);
  for (let i = buf.byteLength - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Overleaf did not return a zip (are you signed in?)');

  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = [];
  const dec = new TextDecoder();

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = dec.decode(new Uint8Array(buf, off + 46, nameLen));

    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = new Uint8Array(buf, start, compSize);

    if (!name.endsWith('/')) {
      let bytes;
      if (method === 0) {
        bytes = raw;
      } else if (method === 8) {
        const stream = new Blob([raw]).stream()
          .pipeThrough(new DecompressionStream('deflate-raw'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      } else {
        throw new Error(`unsupported zip compression method ${method} for ${name}`);
      }
      out.push({ name, bytes });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function b64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

// --- the actual sync -------------------------------------------------------
async function sync({ projectId, projectName, pdfUrl }, report) {
  const cfg = await settings();
  const dest = await routeFor(projectId, cfg, projectName);
  const base = dest.base;
  await assertWritable(dest, cfg);

  report('fetching project from Overleaf');
  const zipRes = await fetch(`https://www.overleaf.com/project/${projectId}/download/zip`, {
    credentials: 'include',
  });
  if (!zipRes.ok) throw new Error(`Overleaf returned ${zipRes.status} for the project zip`);
  const files = await unzip(await zipRes.arrayBuffer());
  report(`${files.length} files; reading the repo`);

  if (pdfUrl) {
    try {
      const p = await fetch(pdfUrl, { credentials: 'include' });
      if (p.ok) {
        // In the shared mirror the id keeps PDFs from colliding. In a project's
        // own repo that name is noise, and a stale committed PDF sitting beside
        // the source is how people end up reading an old version.
        if (!dest.routed) {
          files.push({ name: `${projectId}.pdf`, bytes: new Uint8Array(await p.arrayBuffer()) });
          report(`${files.length} files including the compiled PDF`);
        }
      }
    } catch (_) { /* PDF is a bonus, never fatal */ }
  }

  const { owner, repo, branch } = dest;
  const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, {}, cfg);
  const headSha = ref.object.sha;
  const headCommit = await gh(`/repos/${owner}/${repo}/git/commits/${headSha}`, {}, cfg);
  const baseTree = headCommit.tree.sha;

  // In the mirror the whole subtree belongs to the extension, so anything the
  // project no longer has must go or the mirror accumulates dead files.
  //
  // A project's own repo is different: it holds files the extension did not put
  // there (scripts, .gitignore, CI, a README) and deleting those because
  // Overleaf has never heard of them would be destructive. Routed pushes
  // therefore add and update, and never delete.
  const had = new Set();
  if (!dest.routed) {
    const existing = await gh(
      `/repos/${owner}/${repo}/git/trees/${baseTree}?recursive=1`, {}, cfg);
    for (const e of existing.tree || []) {
      if (e.type === 'blob' && e.path.startsWith(base + '/')) had.add(e.path);
    }
  }

  report(`uploading ${files.length} files`);
  const tree = [];
  for (const f of files) {
    const path = base ? `${base}/${f.name}` : f.name;
    const blob = await gh(`/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: b64(f.bytes), encoding: 'base64' }),
    }, cfg);
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    had.delete(path);
  }
  for (const gone of had) {
    tree.push({ path: gone, mode: '100644', type: 'blob', sha: null });
  }

  if (!tree.length) return { changed: false, message: 'nothing to send' };

  report('committing');
  const newTree = await gh(`/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree }),
  }, cfg);

  if (newTree.sha === baseTree) return { changed: false, message: 'already up to date' };

  const commit = await gh(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: `${projectName || projectId}: sync from Overleaf`,
      tree: newTree.sha,
      parents: [headSha],
    }),
  }, cfg);

  await gh(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  }, cfg);

  await rememberProject(projectId, projectName);
  return {
    changed: true,
    message: `pushed ${files.length} files to ${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
  };
}

// The extension can read the real project name off the page, which is the one
// thing a git clone of an Overleaf project does not carry.
async function rememberProject(id, name) {
  const { projects = {} } = await chrome.storage.local.get('projects');
  projects[id] = { name: name || projects[id]?.name || '', seen: new Date().toISOString() };
  await chrome.storage.local.set({ projects });
}

// --- "you are running old code" ------------------------------------------
// The loaded copy cannot see the folder it came from, so it asks the mirror
// repo instead: EXTENSION_VERSION at the repo root holds the version that
// should be running. Bumped whenever the extension source changes.
function newer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function checkForUpdate() {
  try {
    const cfg = await settings();
    const running = chrome.runtime.getManifest().version;
    const res = await gh(
      `/repos/${cfg.owner}/${cfg.repo}/contents/EXTENSION_VERSION`, {}, cfg);
    const latest = atob(res.content.replace(/\s/g, '')).trim();
    const stale = newer(latest, running);
    await chrome.storage.local.set({ update: { running, latest, stale } });
    return { running, latest, stale };
  } catch (_) {
    return null;          // no token yet, no marker file, offline: never nag
  }
}

chrome.runtime.onInstalled.addListener(checkForUpdate);
chrome.runtime.onStartup.addListener(checkForUpdate);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'seen') { rememberProject(msg.projectId, msg.projectName); return false; }
  // So the page can say where the button will push, before it is pressed.
  if (msg.type === 'where') {
    settings()
      .then(cfg => routeFor(msg.projectId, cfg, msg.projectName))
      .then(d => sendResponse({
        ok: true, owner: d.owner, repo: d.repo, branch: d.branch,
        path: d.base, routed: d.routed, why: d.why,
      }))
      .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === 'repos') {
    settings()
      .then(cfg => accessibleRepos(cfg, { fresh: !!msg.fresh }))
      .then(repos => sendResponse({ ok: true, repos }))
      .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === 'update') {
    chrome.storage.local.get('update').then(async s => {
      sendResponse(s.update || await checkForUpdate());
      checkForUpdate();                       // refresh in the background
    });
    return true;
  }
  if (msg.type !== 'sync') return false;
  const report = (text) => {
    try { chrome.tabs.sendMessage(sender.tab.id, { type: 'progress', text }); } catch (_) {}
  };
  sync(msg, report)
    .then(r => sendResponse({ ok: true, ...r }))
    .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;   // keep the channel open for the async reply
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
