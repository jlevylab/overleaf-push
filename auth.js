// GitHub device flow: you get a short code, type it once on github.com, and the
// extension receives a token without either of us ever handling one by hand.
//
// This runs on the options page rather than in the service worker on purpose.
// MV3 stops an idle worker after about thirty seconds, and the poll below can
// legitimately run for fifteen minutes while you finish authorizing in the other
// tab. The options page is open for exactly as long as that takes.

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Both endpoints answer with JSON only if asked, and both report ordinary
// protocol errors inside a 200, so status alone tells you very little.
async function post(url, params) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(params),
    });
  } catch (e) {
    throw new Error(`Could not reach github.com (${e.message || e}).`);
  }
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(`GitHub answered ${r.status} with something that was not JSON: ${text.slice(0, 200)}`);
  }
}

// GitHub's error slugs are accurate and useless. Say what to do instead.
function explain(d) {
  const code = d.error;
  const detail = d.error_description || '';
  switch (code) {
    case 'device_flow_disabled':
      return 'Device flow is switched off for this app. Open its settings on github.com and tick "Enable Device Flow".';
    // "Not Found" is what both endpoints actually answer for a client ID that
    // does not exist, rather than either documented slug. Verified against
    // github.com, so keep all three.
    case 'Not Found':
    case 'unauthorized_client':
    case 'incorrect_client_credentials':
      return 'GitHub does not recognize that Client ID. Check it against the app\'s settings page.';
    case 'access_denied':
      return 'The request was cancelled on github.com. Press Connect to try again.';
    case 'expired_token':
      return 'That code sat unused too long. Press Connect for a fresh one.';
    case 'incorrect_device_code':
      return 'GitHub rejected the device code. Press Connect to start over.';
    default:
      return detail ? `${detail} (${code})` : `GitHub said: ${code}`;
  }
}

// Step one: ask GitHub for a code to show the user.
async function requestDeviceCode(clientId, scope) {
  const params = { client_id: clientId };
  if (scope) params.scope = scope;
  const d = await post(DEVICE_CODE_URL, params);
  if (d.error) throw new Error(explain(d));
  if (!d.device_code || !d.user_code) throw new Error('GitHub returned no device code.');
  return d;
}

// Step two: wait for you to type it. `onWait` is called with seconds remaining
// so the page can show a countdown rather than an unexplained pause.
async function pollForToken(clientId, device, onWait, cancelled = () => false) {
  let interval = (device.interval || 5) * 1000;
  const deadline = Date.now() + (device.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    if (cancelled()) throw new Error('cancelled');
    const step = Math.min(interval, deadline - Date.now());
    for (let waited = 0; waited < step; waited += 1000) {
      if (cancelled()) throw new Error('cancelled');
      onWait(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
      await sleep(Math.min(1000, step - waited));
    }

    const d = await post(TOKEN_URL, {
      client_id: clientId,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    if (d.access_token) return d;
    if (d.error === 'authorization_pending') continue;
    // GitHub asks us to back off when we poll faster than it likes; it may or
    // may not name the new interval, so add the documented five seconds.
    if (d.error === 'slow_down') {
      interval = (d.interval ? d.interval * 1000 : interval) + 5000;
      continue;
    }
    throw new Error(explain(d));
  }
  throw new Error('That code expired. Press Connect for a fresh one.');
}

// Who did we just become, and how far does the token reach? The scopes header is
// empty for a GitHub App, which is the good case: its reach is the app's
// permissions rather than a blanket grant over everything you own.
async function identify(token) {
  const r = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!r.ok) return { login: null, scopes: null };
  const scopes = (r.headers.get('x-oauth-scopes') || '').trim();
  const user = await r.json();
  return { login: user.login || null, scopes: scopes || null };
}

// The whole dance, wrapped. `ui.code` is handed the user code as soon as GitHub
// issues it so the page can display it while we wait.
//
// Not named `connect`: every element id on the options page also lands on
// window, and there is a button called exactly that.
async function deviceConnect({ clientId, scope }, ui) {
  if (!clientId) {
    throw new Error('No Client ID yet. Register the app once (see README.md), then paste its Client ID under Advanced.');
  }
  const device = await requestDeviceCode(clientId, scope);
  ui.code(device);
  const grant = await pollForToken(clientId, device, ui.wait, ui.cancelled);
  const who = await identify(grant.access_token);
  return {
    token: grant.access_token,
    login: who.login,
    scopes: who.scopes,
    // Present only when the app was left on expiring user tokens, which is the
    // one setting that would make you do this again in eight hours.
    expiresIn: grant.expires_in || null,
    obtained: new Date().toISOString(),
  };
}
