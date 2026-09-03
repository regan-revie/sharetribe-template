# Project: Revie (heyrevie.com) — Sharetribe + Nylas calendar integration

This repo is a fork of `sharetribe/web-template`, the client app for a coach<>client coaching marketplace (heyrevie.com), built on Sharetribe's Marketplace API.

## Goal
Replace/extend Sharetribe's built-in booking calendar with a real calendar/scheduling integration (Nylas), so clients book coaching sessions against a coach's actual connected calendar while Sharetribe continues to handle listings, coach<>client matching, and payment (Stripe Connect, via Sharetribe).

## Working in this repo

### Commands
- Package manager is **yarn** (not npm). Node `^22.22.0 || >=24.0.0`.
- **Run the app:** `op run --env-file=.env -- yarn dev` — starts the React frontend (`scripts/start.js`) and the Express backend (`nodemon server/apiServer.js`) together; backend API on port 3500. The `op run` wrapper injects secrets from 1Password (see the secrets decision below); plain `yarn dev` still runs but without real secrets.
- **Tests:** `yarn test` (client, Jest) and `yarn test-server` (Express server tests). `yarn test-ci` runs both.
- **Format:** `yarn format` (Prettier over `**/*.{js,css}`); CI enforces it via `yarn format-ci`.
- **Config:** `yarn config-check` validates `config/` against the connected Sharetribe environment. `yarn build` produces the production bundle; `yarn start` serves it.

### Repo map
- `src/containers/` — page-level React components. Each container usually has its own `*.duck.js` holding that page's Redux state, action creators, and async thunks.
- `src/ducks/` — global Redux modules (auth, current user, etc.). `src/reducers.js` and `src/store.js` wire everything together.
- `src/components/` — shared presentational components. `src/util/` — helpers (dates, currency, API, validation). `src/transactions/` — client-side transaction-process helpers.
- `config/` — marketplace configuration (branding, listing types, transaction settings), validated by `yarn config-check`.
- `server/` — the Express server: server-side rendering (`server/renderer.js`) plus API endpoints (`server/apiRouter.js` → `server/api/`).
- `server/api/` — server-only endpoints. **Privileged transitions already live here:** `initiate-privileged.js`, `transition-privileged.js`, `transaction-line-items.js`. New privileged/webhook endpoints for the Nylas backend belong here (or a sibling folder), registered in `server/apiRouter.js`.
- `ext/transaction-processes/` — reference copies of the Sharetribe transaction processes (`default-booking`, etc.), each with a `process.edn` definition and a `templates/` folder of notification emails. These are edited here and pushed to Sharetribe with the Sharetribe CLI; the *active* processes actually live in Sharetribe Console.
- `patches/` — `patch-package` patches (currently `final-form` and `@testing-library/user-event`), reapplied on every `yarn install` via the `postinstall` script. If a dependency behaves unexpectedly, check here first.

### "Our own backend" — TODO, decide and record here
It is not yet decided whether the Nylas webhook handler and privileged-transition caller live inside this repo's `server/` directory or as a separate service. This affects where new code goes and how it's deployed. Until it's decided, assume `server/` and keep the Nylas code in its own subfolder so it can be extracted later without untangling it from template code.

### Keeping the fork mergeable
This repo tracks `sharetribe/web-template` as the `upstream` git remote (origin is `regan-revie/sharetribe-template`) and periodically merges upstream releases — `v12.3.0` was the most recent. To keep those merges painless, prefer **adding new files** over editing core `src/` files, and concentrate custom logic in `server/api/`, `ext/`, and clearly named new modules. When a core file genuinely must change, keep the diff small and leave a comment explaining why.

## Who you're working with
Regan is the founder of Revie. Philip is the technical collaborator handling engineering on this project (not the founder) — he's comfortable with git, GitHub, and the command line from data-analysis work, but is newer to web development and React/Redux specifically. Explain web-dev-specific concepts as you go rather than assuming prior front-end experience. Favor small, reviewable changes with clear commit messages — this will become a live business, and Philip needs to be able to follow what changed and why.

## The six requirements that shaped the calendar decision
Sharetribe's built-in calendar can't do these:
1. Coaches do not need to leave the heyrevie.com platform.
2. Coaches can connect their Google / Apple / Outlook calendar easily.
3. Availability and timezones are computed from that connected calendar.
4. Revie defines event types (e.g. "Workshop", "1:1 Session") and coaches choose which ones to sell.
5. Revie controls event styling and reminder emails; third-party branding on the calendar itself is acceptable.
6. Revie can see and track when bookings are created.

## Decisions already made (from prior planning — don't relitigate without new information)
- **Keep Sharetribe as the marketplace engine.** Not building a custom marketplace from scratch — Sharetribe already handles payments, auth, listings, messaging, reviews, and admin, which would be very costly and risky to rebuild.
- **Environment strategy:** develop against a Sharetribe **Build**-plan TEST environment first (cheap, full custom-code access to test data). Only move to the **Extend** plan ($299/mo) and live data once ready to launch.
- **Calendar vendor: Nylas** (Cal.com in every form, and a from-scratch calendar build, were considered and rejected — see below).
  - Cal.com Free/Teams accounts require a coach to visit cal.com's own site (sign up, generate API key, connect calendar) — no embeddable connect-flow on those tiers, so requirement #1 can't be fully met. Cal.com Platform/Atoms *would* embed the whole flow, but per Cal.com's own FAQ it's "now deprecated and under maintenance for existing users only — no new customers can sign up."
  - Cronofy is architecturally a great fit (their flagship case study, Docplanner, is the same marketplace shape) but starts at $819/month — not viable at Revie's current stage.
  - **Nylas** fits: free tier (up to 5 connected calendars, full Scheduler, reminders, webhooks, no credit card), then $15/mo for 10 accounts, $49/mo for 25 — cheaper than Cal.com Teams' flat $12/coach once past a handful of coaches.
    - Requirement #1: use Nylas **"Custom Authentication"**, not "Hosted Authentication" — Revie builds its own "Connect your calendar" UI, Nylas only handles the OAuth handoff straight to Google/Microsoft/Apple. The coach never visits a Nylas-branded page.
    - Requirement #4: use Nylas **Scheduler Configurations** (host, duration, availability rules), created/updated per coach via API. Revie's backend defines the "Workshop" / "1:1 Session" templates and pushes a configuration to a coach's account when they opt in.
    - Requirements #2/#3/#6 (calendar connections, timezone/availability, webhooks) are core Nylas features across all tiers.
    - Requirement #5 (branding OK) means no need to chase a "remove branding" tier at all.
  - **Verify hands-on early in Phase 2** (couldn't confirm from public docs): the actual feel of the Apple/iCloud connect flow; whether free/low-tier webhook payloads carry everything needed for the Sharetribe sync; how flexible reminder-email customization is per tier.
- **Backend architecture (unchanged regardless of vendor):** our own backend owns confirmation/reminder emails; receives a webhook per coach on booking confirm/cancel/reschedule; calls a Sharetribe **privileged transition** (server-only, secret-key-gated) to move the corresponding Sharetribe transaction forward, keeping payment capture tied to Sharetribe.
- **Hosting target:** Render (Railway as fallback). Needs a host that runs a persistent Node/Express server — serverless platforms are not compatible with the Sharetribe Web Template.
- **Secrets management: 1Password, not plaintext `.env` files.** Real secrets (Sharetribe API keys, Nylas API key/client credentials, Stripe keys, etc.) live as items in a 1Password vault. The `.env` file in the repo holds only `op://vault/item/field` references, never real values, and must stay out of git (confirm it's in `.gitignore`). Run the app via `op run --env-file=.env -- <start command>` so secrets are injected into the process environment only for that run. Never hardcode a secret or print one to a log/commit.

## Open questions
- Nylas hands-on checks (see decision above): Apple/iCloud connect UX, free/low-tier webhook payload completeness, reminder-email customization limits per tier.
- (Superseded, no longer relevant: an earlier question about Cal.com's "active user billing" vs "high water mark" billing — moot now that we've moved to Nylas.)

## Backlog — next project after this one: discount codes
Not in scope yet, but worth keeping the architecture compatible: Regan wants discount codes, and there's an existing Stripe integration via Sharetribe. The planned approach (confirmed against Sharetribe's own docs, which use "validating a discount code" as their canonical example for privileged transitions): client submits a code with the booking request → the trusted backend (the same one built for the calendar integration) validates it against a small store of valid codes → backend calls a privileged transition (`privileged-set-line-items`) to recompute Sharetribe's line items with a discount line item → Sharetribe charges the discounted total through its existing Stripe Connect flow, unchanged. No need to touch Stripe's own Coupon/PromotionCode objects. When this project starts, it should mostly be "one more privileged transition + a table of codes" on top of the backend this project builds — don't build the calendar backend in a way that makes that harder later.

## Phased plan
1. **Foundation** — get the stock web-template running locally against the Sharetribe test environment. No customization yet; just prove the baseline works.
2. **Calendar wiring** — sign up for Nylas free tier; verify the open questions above hands-on; build the coach onboarding flow (Custom Authentication calendar connect, event-type opt-in that creates a Scheduler Configuration via API, per-coach webhook registration), the inline booking UI on a coach profile, our own confirmation/reminder emails, and the Sharetribe transaction-process changes (privileged transitions) needed to confirm bookings. All against test data.
3. **Hardening** — reschedules/cancellations initiated from the calendar side, timezone edge cases, abandoned-booking handling.
4. **Go-live** — upgrade to Sharetribe Extend, deploy to Render, point at the live marketplace, onboard real coaches (Nylas calendar connect + event-type selection).

Check with Philip which phase we're currently in if it's not obvious from recent commits/branches.

## Useful references
- Sharetribe Web Template docs: https://www.sharetribe.com/docs/template/introduction/sharetribe-web-template/
- Sharetribe privileged transitions: https://www.sharetribe.com/docs/concepts/transactions/privileged-transitions/
- Sharetribe transaction process docs: https://www.sharetribe.com/docs/concepts/transactions/transaction-process/
- Nylas pricing: https://www.nylas.com/pricing/
- Nylas Scheduler product: https://www.nylas.com/products/scheduler/
- Nylas scheduling use-case docs: https://developer.nylas.com/docs/v3/use-cases/industries/scheduling/
- Nylas Hosted Authentication whitelabeling (and pointer to Custom Authentication): https://developer.nylas.com/docs/dev-guide/whitelabeling/
- Cal.com Platform/Atoms (rejected — deprecated for new customers): https://cal.com/docs/platform/faq
- Cronofy (rejected — good fit, too expensive at this stage): https://www.cronofy.com/api-pricing
