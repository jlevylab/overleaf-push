// Injects the button into Overleaf and drives the recompile.
//
// Everything here is Overleaf-DOM dependent, which is the brittle part of the
// extension. It is written to degrade rather than break: if the recompile
// button cannot be found, the sync still happens, and the button says so.

const PROJECT_ID = (location.pathname.match(/\/project\/([0-9a-f]{24})/) || [])[1];
if (PROJECT_ID) init();

function projectName() {
  const el = document.querySelector('[class*="project-name"], .toolbar-header-title-container');
  const fromDom = el && el.textContent.trim();
  if (fromDom) return fromDom;
  return document.title.replace(/\s*[-–|]\s*Overleaf.*$/i, '').trim();
}

function findRecompile() {
  const byTest = document.querySelector('[data-testid="recompile-button"], .btn-recompile');
  if (byTest) return byTest;
  return [...document.querySelectorAll('button')]
    .find(b => /recompile|compile/i.test(b.textContent || ''));
}

function isCompiling() {
  return !!document.querySelector(
    '[class*="compiling"], [data-testid="compile-status"] [class*="spinner"], .pdf-loading-indicator');
}

function pdfUrl() {
  const frame = document.querySelector('iframe[src*="/output/"], object[data*="/output/"]');
  const src = frame && (frame.src || frame.data);
  if (src) return src;
  const link = [...document.querySelectorAll('a[href*="/output/output.pdf"]')][0];
  return link ? link.href : null;
}

async function recompile(say) {
  const btn = findRecompile();
  if (!btn) { say('no recompile button found, syncing anyway'); return false; }
  say('recompiling');
  btn.click();

  // give it a moment to enter the compiling state, then wait for it to leave
  await new Promise(r => setTimeout(r, 1200));
  const deadline = Date.now() + 180000;   // a long book can take a while
  while (isCompiling() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));
  }
  if (Date.now() >= deadline) { say('compile still running, syncing sources anyway'); return false; }
  await new Promise(r => setTimeout(r, 1500));   // let the viewer settle on the new PDF
  return true;
}

// Sit in the toolbar beside Recompile. Overleaf's editor is React and rerenders
// that bar, so the button gets re-mounted whenever it is torn out, and falls
// back to floating bottom-right if the toolbar cannot be found at all.
function mount(btn) {
  if (btn.isConnected) return;
  const rc = findRecompile();
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

  const btn = document.createElement('button');
  btn.id = 'olpush-btn';
  btn.type = 'button';
  btn.textContent = 'Push to git';
  mount(btn);
  new MutationObserver(() => mount(btn))
    .observe(document.body, { childList: true, subtree: true });

  const say = (text) => { btn.textContent = text; };
  chrome.runtime.onMessage.addListener(m => { if (m.type === 'progress') say(m.text); });

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.remove('ok', 'bad');
    try {
      const compiled = await recompile(say);
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
      setTimeout(() => {
        btn.disabled = false;
        btn.classList.remove('ok', 'bad');
        say('Push to git');
      }, 6000);
    }
  });
}
