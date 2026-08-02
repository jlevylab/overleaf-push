// Service worker: does the work the page cannot.
//
// Overleaf auth is just the browser session, so fetching the project zip needs
// no token at all. The only secret in this extension is a GitHub fine-grained
// PAT scoped to the one mirror repo.

const GH = 'https://api.github.com';

async function settings() {
  const s = await chrome.storage.local.get(['token', 'owner', 'repo', 'branch']);
  if (!s.token) throw new Error('No GitHub token set. Open the extension options.');
  if (!s.owner || !s.repo) throw new Error('No target repo set. Open the extension options.');
  return { branch: 'main', ...s };
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
  const base = `overleaf/${projectId}`;

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
        files.push({ name: `${projectId}.pdf`, bytes: new Uint8Array(await p.arrayBuffer()) });
        report(`${files.length} files including the compiled PDF`);
      }
    } catch (_) { /* PDF is a bonus, never fatal */ }
  }

  const { owner, repo, branch } = cfg;
  const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, {}, cfg);
  const headSha = ref.object.sha;
  const headCommit = await gh(`/repos/${owner}/${repo}/git/commits/${headSha}`, {}, cfg);
  const baseTree = headCommit.tree.sha;

  // Anything currently under overleaf/<id>/ that the project no longer has
  // must be deleted, or the mirror silently accumulates dead files.
  const existing = await gh(
    `/repos/${owner}/${repo}/git/trees/${baseTree}?recursive=1`, {}, cfg);
  const had = new Set(
    (existing.tree || [])
      .filter(e => e.type === 'blob' && e.path.startsWith(base + '/'))
      .map(e => e.path));

  report(`uploading ${files.length} files`);
  const tree = [];
  for (const f of files) {
    const path = `${base}/${f.name}`;
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
    message: `pushed ${files.length} files`,
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'seen') { rememberProject(msg.projectId, msg.projectName); return false; }
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
