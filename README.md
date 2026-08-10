# Overleaf to git

A Chrome extension that puts one button in the Overleaf toolbar. Press it and the project recompiles, then the whole source tree and the compiled PDF are committed to a GitHub repo. Pressing Overleaf's own **Recompile**, or Ctrl/Cmd+Enter, does the same thing, so there is only ever one thing to press.

Projects land in `overleaf/<project-id>/` in the mirror repo. Files you delete in Overleaf are deleted in the mirror, so it stays a true copy rather than an accumulating pile.

Overleaf itself needs no credentials: the extension rides the browser session you are already signed into. The only credential anywhere in this thing is a GitHub token, and you should never have to create one by hand.

## Setup, part one: once ever, for all machines

This is the part you do a single time. Once the Client ID is committed to `config.js`, every machine after this is four clicks and no tokens.

Register a **GitHub App** owned by the organization that holds the mirror repo:

1. Go to https://github.com/organizations/levylabpitt/settings/apps/new
2. **GitHub App name:** `Overleaf to git (levylabpitt)`. The name has to be unique across all of GitHub, so plain "Overleaf to git" will probably be taken.
3. **Homepage URL:** `https://github.com/jlevylab/overleaf-push`. It is a required field and nothing reads it.
4. **Webhook:** untick **Active**. Leave it ticked and the form demands a webhook URL you have no use for.
5. **Permissions** → **Repository permissions** → **Contents** → **Read and write**. Nothing else. (Metadata read-only switches itself on and cannot be turned off. That is normal.)
6. **Where can this GitHub App be installed?** → **Only on this account**.
7. Create the app.

Then, on the app's settings page, two switches that both matter:

8. Under **Identifying and authorizing users**, tick **Enable Device Flow**. Without it the Connect button gets a flat refusal from GitHub.
9. On the same page, **untick "Expire user authorization tokens"**. This is the setting that decides whether you do this again in eight hours or never again. The options page will warn you if you miss it.

Finally, give the app its reach and record its ID:

10. **Install App** in the left sidebar → install on `levylabpitt` → **Only select repositories** → pick `overleaf`. The token can reach exactly this repo and nothing else, which is the whole reason for going through an app rather than a blanket token.
11. Copy the **Client ID** from the app's settings page. It looks like `Iv23liAbCdEf...`.
12. Paste it into [`config.js`](config.js) as `OLPUSH_CLIENT_ID` and commit it.

A Client ID is public by design. The device flow exists for clients that cannot keep a secret, and this app has no secret at all, so committing the ID is safe. It is also what makes step two below trivial.

### If you register an OAuth App instead

An OAuth App is quicker to create (https://github.com/settings/applications/new, then tick **Enable Device Flow** on its page) but it has no per-repository permissions. Its device flow needs `OLPUSH_SCOPE = 'repo'` in `config.js`, and `repo` reaches every repository your account can touch, forever. It works, and it is worse. Prefer the GitHub App.

## Setup, part two: each machine, about a minute

1. Clone this repo somewhere permanent. The extension runs from the folder, so a temp directory will bite you later.
2. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose the folder.
3. Click the extension's icon to open its options.
4. Press **Connect GitHub**. A short code appears. Press **Copy code**, then **Open github.com**, paste the code, and authorize. The options page notices on its own within a few seconds.
5. Check **Owner** / **Repository** / **Branch** (`levylabpitt` / `overleaf` / `main`) and press **Save**. It should say the repo is reachable.

No token is ever typed, pasted, or stored by you. If you would rather do it by hand anyway, **Paste a token by hand instead** on the options page still takes a fine-grained PAT with `Contents: read and write` on the one repo.

## The mirror repo

It has to exist already and have at least one commit, because the extension commits onto an existing branch tip rather than creating a repository. Currently `levylabpitt/overleaf`, private, default branch `main`.

## Releasing a change

The loaded copy of an unpacked extension cannot see the folder it came from, so it asks the mirror repo instead. A file called `EXTENSION_VERSION` at the root of the mirror repo holds the version that ought to be running, and any machine running something older turns the button orange and says so.

So when you change the source:

1. Bump `version` in [`manifest.json`](manifest.json).
2. Commit and push here.
3. Write the same number into `EXTENSION_VERSION` at the root of `levylabpitt/overleaf`.
4. On each machine: **Reload** at `chrome://extensions`, then reload any open Overleaf tab. Reloading the extension orphans content scripts in tabs that were already open, which is why the button starts saying "Reload this tab" instead of failing mysteriously.

## When it misbehaves

| What you see | What it means |
| --- | --- |
| "Device flow is switched off for this app" | Step 8 above was missed. |
| "GitHub does not recognize that Client ID" | `OLPUSH_CLIENT_ID` is wrong or empty. Check it against the app's settings page. |
| "Cannot see levylabpitt/overleaf ... the app is not installed on that repository yet" | Step 10 above. Creating the app does not install it. |
| "GitHub rejected the token" | The token died, usually because step 9 was missed and it expired. Press Connect again, then go untick that box. |
| "Reload this tab" on the button | The extension was reloaded underneath an open tab. Refresh the page. |
| "Overleaf did not return a zip (are you signed in?)" | The Overleaf session lapsed. Sign in again in that tab. |
| Button never appears | Overleaf changed its toolbar markup. `content.js` falls back to a floating button at bottom right; if even that is missing, the DOM selectors in `compileButton()` need attention. |

## The files

| | |
| --- | --- |
| `manifest.json` | permissions and wiring |
| `config.js` | the Client ID, committed on purpose |
| `auth.js` | GitHub device flow, run from the options page |
| `options.html` / `options.js` | settings, connection, list of projects seen |
| `background.js` | service worker: fetches the zip, unpacks it, commits the tree |
| `content.js` / `content.css` | the button in the Overleaf toolbar |

`auth.js` runs on the options page rather than in the service worker deliberately. MV3 stops an idle service worker after about thirty seconds, and the device flow poll can legitimately run for fifteen minutes while you finish authorizing in another tab. The options page is open for exactly that long.
