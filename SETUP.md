# Setting up Revie on a new machine

Everything needed to get the marketplace running locally and to work on it with Claude. Written for
a fresh Mac. Allow about an hour, most of which is waiting for installs and clicking through access
requests.

If something here is wrong or missing, fix it in this file — it is the only page anyone should need.

---

## 1. Access you need before starting

These are requests to other people or accounts, so start them first and do the installs while you
wait.

| What | Why | Who grants it |
|---|---|---|
| **GitHub** access to `regan-revie/sharetribe-template` | the code | Regan owns the repo |
| **1Password** access to the **`Revie Dev`** vault | every credential the app needs | Philip / Regan |
| **Sharetribe Console** | marketplace configuration and the Dev environment | existing Console admin |
| **Nylas dashboard** | calendar integration | existing Nylas account |
| **Render dashboard** | the deployed dev service and its database | existing Render account |
| **Google Cloud Console** | the OAuth clients for sign-in and calendar | existing project owner |

You can get the app running locally with only the first two. The rest are needed to change
configuration, not to run it.

---

## 2. Install the tools

> **Run these in the Mac Terminal, not VS Code's terminal, and restart VS Code once you are done.**
> Either works for the install itself, but nvm edits your shell profile, and VS Code inherits its
> environment when it launches — so tools installed inside VS Code's own terminal may be invisible to
> VS Code until it restarts. That matters here because Claude's shell runs under VS Code: if
> `node -v` gives one answer in your terminal and another to Claude, this is why.

**Node.js.** The project needs Node `^22.22.0` or `>=24.0.0`; the team runs **24.20.0**. The easiest
route is [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install 24.20.0
nvm use 24.20.0
node -v          # expect v24.20.0
```

**Yarn 1.x** — the project uses Yarn, not npm, and mixing them corrupts the lockfile:

```bash
npm install -g yarn
yarn -v          # expect 1.22.x
```

**Git** comes with Xcode command line tools: `xcode-select --install`.

**VS Code** from [code.visualstudio.com](https://code.visualstudio.com). While it is open, press
`⌘⇧P` and run **"Shell Command: Install 'code' command in PATH"** — some steps below assume it.

**1Password desktop app** from [1password.com/downloads](https://1password.com/downloads), plus the
CLI:

```bash
brew install --cask 1password-cli
op --version
```

---

## 3. Set up 1Password — the fiddly part

No real secret is ever written into a file in this project. `.env` holds only *references* like
`op://Revie Dev/nylas_sandbox_api_key/revie_dev`, and the `op` command swaps them for real values
just for the moment the app runs. That means `op` has to work before anything else will.

**Three things must all be true**, and each has caused an hour of confusion before:

1. **The 1Password desktop app is open** — not merely installed, and not just unlocked in the
   background. If it has been quit, `op` fails with *"couldn't connect to the 1Password desktop
   app"*.
2. **CLI integration is on.** In the app: **Settings (⌘,) → Developer → tick "Integrate with
   1Password CLI"**.
3. **VS Code has macOS permission to drive it.** The first time it is needed, macOS shows a prompt
   reading *"Visual Studio Code would like to access data from other apps"* — **you must click
   Allow**. If you miss it, grant it manually at **System Settings → Privacy & Security →
   Automation → Visual Studio Code**, then restart VS Code.

Check it works:

```bash
op account list      # should list the account, not come back empty
op vault list        # should include "Revie Dev"
```

> **`op whoami` is a bad test.** It reports the same failure whether the app is locked, the
> integration is off, or no account exists. `op account list` is the one that distinguishes them —
> empty means the CLI genuinely has no account configured.

---

## 4. Get the code

```bash
mkdir -p ~/Documents/GitHub/revie
cd ~/Documents/GitHub/revie
git clone https://github.com/regan-revie/sharetribe-template.git
cd sharetribe-template
yarn install
```

`yarn install` takes a few minutes and applies two patches automatically at the end — that is normal,
not an error.

The repo also tracks the upstream Sharetribe template so we can pull in their releases:

```bash
git remote add upstream https://github.com/sharetribe/web-template.git
```

---

## 5. Create the `.env` file

**This is the step a fresh clone cannot do for you.** `.env` is deliberately excluded from git, so
it does not exist after cloning and the app will not start without it.

Create a file called `.env` in the project root with exactly this. There are no secrets here — every
sensitive value is a pointer into 1Password:

```bash
# Sharetribe Marketplace API
REACT_APP_SHARETRIBE_SDK_CLIENT_ID=op://Revie Dev/sharetribe_dev_id/client_id
SHARETRIBE_SDK_CLIENT_SECRET=op://Revie Dev/sharetribe_dev_secret/client_secret

# Sharetribe Integration API - a separate Console application, used by the Nylas webhook
SHARETRIBE_INTEGRATION_CLIENT_ID=op://Revie Dev/sharetribe_dev_nylas/client_id
SHARETRIBE_INTEGRATION_CLIENT_SECRET=op://Revie Dev/sharetribe_dev_nylas/client_secret

# Nylas calendar integration. No REACT_APP_ prefix: that prefix publishes a value to every
# visitor's browser, so an API key must never carry it.
NYLAS_API_KEY=op://Revie Dev/nylas_sandbox_api_key/revie_dev
NYLAS_CLIENT_ID=op://Revie Dev/nylas_sandbox_client_id/client_id
NYLAS_API_BASE_URL=https://api.us.nylas.com
NYLAS_WEBHOOK_SECRET=op://Revie Dev/nylas_dev_webhook_secret/credential

# Google sign-in
REACT_APP_GOOGLE_CLIENT_ID=op://Revie Dev/google_login_oauth/client_id
GOOGLE_CLIENT_SECRET=op://Revie Dev/google_login_oauth/client_secret

# Not yet set up - leave empty
REACT_APP_STRIPE_PUBLISHABLE_KEY=
REACT_APP_MAPBOX_ACCESS_TOKEN=
REACT_APP_FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=

# Local defaults
REACT_APP_MARKETPLACE_ROOT_URL=http://localhost:3000
REACT_APP_MARKETPLACE_NAME=revie_dev
REACT_APP_ENV=production
REACT_APP_CSP=report
```

Check every reference resolves. This prints only true/false, never a secret:

```bash
op run --env-file=.env -- node -e "
['REACT_APP_SHARETRIBE_SDK_CLIENT_ID','SHARETRIBE_SDK_CLIENT_SECRET','NYLAS_API_KEY',
 'NYLAS_WEBHOOK_SECRET','SHARETRIBE_INTEGRATION_CLIENT_ID','REACT_APP_GOOGLE_CLIENT_ID']
 .forEach(k => console.log((process.env[k] && !process.env[k].startsWith('op://')) ? 'OK  ' : 'FAIL', k));
"
```

All six must say `OK`. A `FAIL` means either the 1Password item name has changed or you do not have
access to the `Revie Dev` vault.

---

## 6. Run it

```bash
op run --env-file=.env -- yarn dev
```

That starts two things: the website on **http://localhost:3000** and an API server on **port 3500**.
Leave it running; it reloads as files change. First compile takes 30–60 seconds.

Open http://localhost:3000. The dev marketplace is **private**, so you will be asked to sign in
rather than shown a public homepage — that is correct, not a fault.

### Always check the secrets actually loaded

`op run` does not always fail loudly. If the 1Password prompt goes unanswered, it will start the app
anyway with the literal text `op://Revie Dev/...` in place of every secret. Nothing complains until
something breaks in a way that points at entirely the wrong thing — Google once rejected a sign-in
with `Error 401: invalid_client`, because the client ID it received was the string `op://...`.

After starting, run this in a second terminal:

```bash
curl -sD- http://localhost:3500/api/auth/google -o /dev/null | grep -i location
```

If the URL contains `client_id=op%3A%2F%2F`, the whole app is running on placeholders. Stop it, make
sure 1Password is open and unlocked, and start again.

---

## 7. Working with Claude

Open the project in VS Code (`code .` from the project directory) and start Claude Code there.

Claude reads **`CLAUDE.md`** in the project root at the start of every session. That file holds the
architecture, every decision made and why, and a long list of traps already discovered — it is worth
skimming once, and it is where Claude records anything new.

Two things about running the app with Claude:

- Claude can usually start the dev server itself, provided the 1Password Automation permission in
  step 3 is granted. If `op` misbehaves from Claude's side, the fallback is to run
  `op run --env-file=.env -- yarn dev` in your own terminal and leave it running — Claude can then
  check the app over HTTP, which needs no secrets.
- **Never paste a real secret into the chat.** Claude can read them through `op` when it genuinely
  needs to; a secret pasted into a conversation is a secret in a transcript.

---

## 8. Where everything lives

| Thing | Where | Notes |
|---|---|---|
| Code | `github.com/regan-revie/sharetribe-template` | branch `main`; deploys automatically |
| Deployed dev site | `revie-dev.onrender.com` | Render, Frankfurt, Starter plan |
| Database | Render `revie-dev-db` | holds the Nylas booking ↔ Sharetribe transaction mapping |
| Marketplace config | Sharetribe Console → **Dev** environment | listing types, branding, access control |
| Calendar | Nylas dashboard (**US** region, Sandbox) | connectors, Scheduler configurations, webhooks |
| Sign-in + calendar OAuth | Google Cloud Console | two *separate* OAuth clients — do not mix them |
| Secrets | 1Password → **`Revie Dev`** vault | plus Render's own environment store for the deployed app |

**A Sharetribe wrinkle worth knowing early.** There are three environments: **Dev** (the only one
that runs our custom code, and what you work against), **Test** (a no-code preview), and **Live**.
Configuration changes are made in **Test** and copied forward to Dev and Live using the "Copy changes
to…" button. Editing Dev or Live directly is how they silently fall out of step, which has already
happened once.

---

## 9. Common problems

**`op` says "You are not currently signed in" or "No accounts configured".**
The 1Password app is closed, the CLI integration is off, or VS Code lacks the Automation permission.
Work through step 3 again. `op account list` tells you which.

**The app starts but nothing works, and errors mention `op://`.**
Secrets did not resolve. See the check at the end of step 6.

**`yarn install` fails or behaves oddly.**
Check you are on Node 24 (`node -v`) and using Yarn rather than npm. If in doubt,
`rm -rf node_modules && yarn install`.

**The site asks me to log in and I have no account.**
Sign up on `localhost:3000`. On the Dev environment new listings need approval in Console before they
appear.

**A change is not showing up on `revie-dev.onrender.com`.**
Render deploys from `main` on push. Note that any variable starting `REACT_APP_` is baked into the
site when it is built, so changing one needs a full rebuild rather than a restart.

---

## 10. Running the tests

```bash
yarn test-server     # the Express API and the Nylas integration
yarn test            # the React app
```

Both should be fully green. If they are not on a fresh clone, something is wrong with the setup
rather than with the code.
