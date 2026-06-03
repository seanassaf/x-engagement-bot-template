# X Engagement Bot — Template

A configurable bot that runs an X (Twitter) account like a human: it logs in via a real
browser, scrolls the feed (or search/community), filters & ranks posts for your niche,
writes context-aware replies with an LLM, and likes/replies with human-like pacing.

This is a **blank template** — fill in the placeholders for your own brand/niche and go.

---

## How it works

Browser-automation first. Three external pieces, each with one job:

| Piece | Role | Used for |
|---|---|---|
| **Chrome + Puppeteer** | the hands | scrolling the feed, clicking Like, typing + posting replies |
| **X API** (read-only, OAuth 1.0a) | the eyes | fetching author follower counts / tweet metadata for filtering — never posts |
| **LLM** (Anthropic or OpenAI-compatible) | the writer | generating 3 reply candidates per post in your persona's voice |

Per session: launch logged-in Chrome → discover posts → enrich + filter (size caps,
sensitive-topic filter, relevance, retweet/quote skips) → rank → for each target: like,
ask the LLM for replies, post candidate #1 → human-like delays between actions.

---

## Setup

1. **Install** (Node ≥ 22, which runs `.ts` directly):
   ```bash
   pnpm install      # or: npm install
   ```
2. **Credentials** — copy the env template and fill it in:
   ```bash
   cp .env.example .env
   ```
   - `X_API_*` (4 keys): from your X developer app → Keys and tokens → **OAuth 1.0 Keys** (Consumer Key/Secret + Access Token/Secret). Read permission is enough.
   - `LLM_API_KEY` + `LLM_MODEL` (+ `LLM_BASE_URL` for Anthropic: `https://api.anthropic.com/v1`).
   - `X_USER_<KEY>` / `X_PASS_<KEY>` — the X login for your account (default key: `myaccount`).
3. **First login** (one-time): X blocks fully-automated logins, so seed the session by hand once:
   - set `X_LOGIN_MANUAL_MYACCOUNT=1` in `.env`, run a session **headed** in a real Terminal,
     log in manually in the Chrome window that opens, then close it. The session is saved to
     `.x-browser-profiles/<key>/`. Then unset the flag — future runs reuse it (headless OK).
4. **Customize for your niche** (the fill-in checklist below).

## Fill-in checklist (search for `TODO`)

| File | What to set |
|---|---|
| `twitter-guerilla/lib/accounts.ts` | `DEFAULT_ACCOUNT_KEY` (and rename `personas/<key>.md`) |
| `twitter-guerilla/personas/<key>.md` | your account's voice |
| `twitter-guerilla/base-persona.md` | shared engagement rules + hard rules |
| `twitter-guerilla/lib/intent.ts` | `BUYER_INTENT_QUERIES`, demand/operator/automation phrase lists, `CATEGORY_CONTEXT_TERMS`, `COMPETITOR_VENDOR_USERNAMES` |
| `twitter-guerilla/lib/discovery.ts` | `CORE_KEYWORDS`, `RELEVANCE_KEYWORDS`, `COMPETITOR_BRAND_TERMS`, `isPriorityAccountProfile` |
| `twitter-guerilla/lib/session-cli.ts` | `KEYWORD_SEARCH_SET` |
| `twitter-guerilla/lib/config.ts` | default `engagementContext` (brand description fed to the LLM) |
| `twitter-guerilla/lib/reply-policy.ts` | `PRODUCT_NAME` (so the bot never names/pitches it) |
| `twitter-guerilla/lib/hard-rules.ts` | `BLOCKED_USERNAMES` (accounts to never engage) |
| `twitter-guerilla/lib/sensitive-content.ts` | brand-safety blocklist (generic defaults provided) |
| `twitter-guerilla/lib/llm.ts` | analytical/casual term lists + prompt examples (optional) |

## Run

```bash
# dry-run (discovers + generates replies, posts NOTHING):
node ./marketing.ts session myaccount --dry-run --likes 1 --comments 1

# live (posts real likes + replies):
node ./marketing.ts session myaccount --likes 8 --comments 8

# targeted/buyer-intent mode (searches your BUYER_INTENT_QUERIES instead of the home feed):
node ./marketing.ts session myaccount --buyer-intent

# run headless (recommended — reliable, no window; also how the scheduler/deploy runs):
BROWSER_HEADLESS=true node ./marketing.ts session myaccount --likes 1 --comments 1

pnpm test    # run the test suite
```

## Scheduler / deploy

`twitter-guerilla/railway-scheduler.ts` is meant to be invoked every ~5 min (cron/launchd);
it self-limits to working hours and fires 1–5 random sessions/day. A `Dockerfile` +
`RAILWAY_SETUP.md` are included for headless deployment on Railway (persist the browser
profile in a volume; see the cookie-seeding flow in `RAILWAY_SETUP.md`).

## ⚠️ Operating notes

- **Don't hammer X.** Rapid back-to-back sessions get throttled (blank pages) and risk
  flagging the account. Space sessions out; the scheduler already does.
- **Season new accounts gently** — start with low daily volume and ramp over weeks.
- **Residential IP is safer than datacenter.** X scrutinizes datacenter IPs (e.g. cloud
  hosts) far more; consider a residential proxy if deploying to the cloud.
- This automates engagement on X; review X's Terms of Service and use responsibly.

## Project layout

```
marketing.ts                  CLI entry
twitter-guerilla/
  personas/<key>.md           per-account voice
  base-persona.md             shared rules
  railway-scheduler.ts        scheduler
  lib/                        intent, discovery, sensitive-content, llm,
                              reply-policy, hard-rules, config, browser, ...
test/twitter-guerilla/        test suite (node --test)
```
