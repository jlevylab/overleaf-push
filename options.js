const $ = id => document.getElementById(id);

chrome.storage.local.get(['token', 'owner', 'repo', 'branch', 'projects']).then(s => {
  $('token').value = s.token || '';
  $('owner').value = s.owner || 'levylabpitt';
  $('repo').value = s.repo || 'overleaf';
  $('branch').value = s.branch || 'main';
  render(s.projects || {});
});

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

$('save').addEventListener('click', async () => {
  const cfg = {
    token: $('token').value.trim(),
    owner: $('owner').value.trim(),
    repo: $('repo').value.trim(),
    branch: $('branch').value.trim() || 'main',
  };
  const msg = $('msg');
  msg.className = '';
  if (!cfg.token || !cfg.owner || !cfg.repo) {
    msg.className = 'bad';
    msg.textContent = 'Token, owner and repository are all required.';
    return;
  }
  msg.textContent = 'checking the repo...';
  try {
    const r = await fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${cfg.branch}`,
      { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' } });
    if (!r.ok) {
      msg.className = 'bad';
      msg.textContent = r.status === 404
        ? `Cannot see ${cfg.owner}/${cfg.repo} on branch ${cfg.branch}. Check the name, the branch, and that the token grants this repo.`
        : `GitHub said ${r.status}. Check the token's permissions.`;
      return;
    }
    await chrome.storage.local.set(cfg);
    msg.className = 'ok';
    msg.textContent = 'Saved, and the repo is reachable.';
  } catch (e) {
    msg.className = 'bad';
    msg.textContent = String(e.message || e);
  }
});
