// Injects the button into Overleaf, drives the recompile, and pushes after any
// compile you start yourself.
//
// Everything here depends on Overleaf's DOM, which is the brittle part of the
// extension. It is written to degrade rather than break.

const PROJECT_ID = (location.pathname.match(/\/project\/([0-9a-f]{24})/) || [])[1];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let busy = false;
let btn;

if (PROJECT_ID) init();

function projectName() {
  const el = document.querySelector('[class*="project-name"], .toolbar-header-title-container');
  const fromDom = el && el.textContent.trim();
  if (fromDom) return fromDom;
  return document.title.replace(/\s*[-–|]\s*Overleaf.*$/i, '').trim();
}

// Overleaf relabels this same button "Compiling…" while a build runs, which is
// a far more reliable signal than hunting for spinner class names.
function compileButton() {
  return [...document.querySelectorAll('button')]
    .find(b => b.id !== 'olpush-btn' && /^(recompile|compiling)/i.test((b.textContent || '').trim()));
}

function isCompiling() {
  const b = compileButton();
  if (b && /compiling/i.test(b.textContent || '')) return true;
  return !!document.querySelector('[class*="compiling"], .pdf-loading-indicator');
}

function pdfUrl() {
  const frame = document.querySelector('iframe[src*="/output/"], object[data*="/output/"]');
  const src = frame && (frame.src || frame.data);
  if (src) return src;
  const link = document.querySelector('a[href*="/output/output.pdf"]');
  return link ? link.href : null;
}

async function waitForCompile(say) {
  const t0 = Date.now();
  while (!isCompiling() && Date.now() - t0 < 8000) await sleep(250);   // let it start
  if (!isCompiling()) return false;                                     // it never did
  while (isCompiling() && Date.now() - t0 < 240000) { say('compiling'); await sleep(500); }
  await sleep(1500);                                                    // let the viewer swap in the new PDF
  return true;
}

// --- the shared push -------------------------------------------------------
async function push({ recompileFirst }, say) {
  if (busy) return;
  busy = true;
  btn.disabled = true;
  btn.classList.remove('ok', 'bad');
  try {
    let compiled = false;
    if (recompileFirst) {
      const rc = compileButton();
      if (rc) { say('recompiling'); rc.click(); compiled = await waitForCompile(say); }
      else say('no recompile button, pushing anyway');
    } else {
      compiled = await waitForCompile(say);
    }

    say('sending');
    const res = await chrome.runtime.sendMessage({
      type: 'sync',
      projectId: PROJECT_ID,
      projectName: projectName(),
      pdfUrl: compiled ? pdfUrl() : null,
    });

    if (res && res.ok) {
      btn.classList.add('ok');
      say(res.changed ? res.message : 'already up to date');
    } else {
      btn.classList.add('bad');
      say((res && res.error) || 'failed');
      console.error('[overleaf-push]', res && res.error);
    }
  } catch (e) {
    btn.classList.add('bad');
    say(String(e.message || e));
    console.error('[overleaf-push]', e);
  } finally {
    busy = false;
    setTimeout(() => {
      btn.disabled = false;
      btn.classList.remove('ok', 'bad');
      say('Push to git');
    }, 6000);
  }
}

// Sit in the toolbar beside Recompile. Overleaf's editor is React and rerenders
// that bar, so re-mount whenever the button is torn out.
function mount() {
  if (btn.isConnected) return;
  const rc = compileButton();
  const group = rc && (rc.closest('[class*="toolbar"] > *') || rc.parentElement);
  if (group && group.parentElement) {
    group.parentElement.insertBefore(btn, group.nextSibling);
    btn.dataset.placement = 'toolbar';
  } else {
    document.body.appendChild(btn);
    btn.dataset.placement = 'floating';
  }
}

function init() {
  chrome.runtime.sendMessage({
    type: 'seen', projectId: PROJECT_ID, projectName: projectName(),
  });

  btn = document.createElement('button');
  btn.id = 'olpush-btn';
  btn.type = 'button';
  btn.textContent = 'Push to git';
  mount();
  new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });

  const say = text => { btn.textContent = text; };
  chrome.runtime.onMessage.addListener(m => { if (m.type === 'progress') say(m.text); });

  // Tell him when the loaded copy is behind the source, rather than letting him
  // wonder why a fix did nothing.
  chrome.runtime.sendMessage({ type: 'update' }).then(u => {
    if (!u) return;
    btn.title = `Overleaf to git ${u.running}`;
    if (u.stale) {
      btn.classList.add('stale');
      btn.title = `Running ${u.running}, but ${u.latest} is available. `
                + `Reload the extension at chrome://extensions, then reload this tab.`;
      const note = document.createElement('div');
      note.id = 'olpush-stale';
      note.textContent = `Overleaf to git ${u.latest} is ready. `
                       + `Reload it at chrome://extensions (you are on ${u.running}).`;
      note.title = 'click to dismiss';
      note.addEventListener('click', () => note.remove());
      document.body.appendChild(note);
    }
  }).catch(() => {});

  btn.addEventListener('click', () => push({ recompileFirst: true }, say));

  // Pressing Overleaf's own Recompile should push too, so there is only ever
  // one thing to press. Capture phase, because React stops propagation.
  document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('button');
    if (!t || t.id === 'olpush-btn' || busy) return;
    if (!/^recompile/i.test((t.textContent || '').trim())) return;
    setTimeout(() => push({ recompileFirst: false }, say), 300);
  }, true);

  // Ctrl/Cmd+Enter is the shortcut for the same thing.
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !busy) {
      setTimeout(() => push({ recompileFirst: false }, say), 300);
    }
  }, true);
}
