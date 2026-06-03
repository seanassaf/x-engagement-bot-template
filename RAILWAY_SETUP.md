# Railway Setup

This project can run on Railway as a scheduled cron service so sessions continue while your laptop is off.

## Recommended deployment model

- Use a single Railway service built from the root `Dockerfile`
- Attach a Railway volume to persist:
  - `.x-browser-profiles`
  - `.x-session-logs`
- Run the service as a Railway Cron Job
- Use the scheduler command as the default scheduled task

## Why this setup

- Railway cron jobs are designed for short-lived scheduled tasks that start, run, and exit
- Railway volumes persist browser/session state between runs
- The Dockerfile installs Chromium and runs the automation in headless mode

Official Railway docs:

- Cron Jobs: https://docs.railway.com/reference/cron-jobs
- Volumes: https://docs.railway.com/guides/volumes
- Dockerfiles: https://docs.railway.com/builds/dockerfiles
- Variables: https://docs.railway.com/variables

## Service configuration

### 1. Connect the repo

Create a Railway service from this repository root so Railway detects the `Dockerfile`.

### 2. Attach a volume

Attach a volume to the service and mount it at:

```text
/data
```

At runtime the app will automatically use:

- `/data/.x-browser-profiles`
- `/data/.x-session-logs`

because Railway provides `RAILWAY_VOLUME_MOUNT_PATH=/data`.

### 3. Set environment variables

Required app variables:

```text
LLM_API_KEY=...
LLM_MODEL=...
X_API_KEY=...
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_SECRET=...
X_USER_MYACCOUNT=...
X_PASS_MYACCOUNT=...
```

Recommended login/support variables:

```text
X_LOGIN_IDENTIFIER_MYACCOUNT=...
```

Recommended browser/runtime variables:

```text
BROWSER_HEADLESS=true
BROWSER_DISABLE_SANDBOX=true
CHROME_PATH=/usr/bin/chromium
```

Optional path overrides if you do not want the defaults:

```text
BROWSER_PROFILES_DIR=/data/.x-browser-profiles
SESSION_LOGS_DIR=/data/.x-session-logs
```

Recommended scheduler variables:

```text
SESSION_SCHEDULER_TIMEZONE=America/New_York
SESSION_SCHEDULER_START_HOUR=9
SESSION_SCHEDULER_END_HOUR=18
SESSION_SCHEDULER_WEEKDAYS=1,2,3,4,5
SESSION_SCHEDULER_MIN_PER_DAY=1
SESSION_SCHEDULER_MAX_PER_DAY=5
SESSION_SCHEDULER_WEEKEND_MIN_PER_DAY=0
SESSION_SCHEDULER_WEEKEND_MAX_PER_DAY=5
SESSION_SCHEDULER_MIN_GAP_MINUTES=60
SESSION_SCHEDULER_SLOT_MINUTES=5
SESSION_SCHEDULER_SESSION_ARGS=session myaccount --buyer-intent-random
```

### 4. Start command

For the randomized scheduler:

```text
pnpm railway:scheduler
```

Dry run:

```text
pnpm railway:scheduler:dry-run
```

Manual one-off session right now:

```text
pnpm railway:run-now
```

Manual one-off dry run right now:

```text
pnpm railway:run-now:dry-run
```

### 5. Configure the cron schedule

Recommended schedule:

- Every 5 minutes:

```text
*/5 * * * *
```

Reminder:

- Railway cron uses UTC
- minimum interval is 5 minutes
- the scheduler itself filters to your configured working hours and randomly chooses 1 to 5 sessions per active day
- if a previous run is still active, the next cron execution is skipped

## Important operational note

This setup works best when the account can log in headlessly using:

- username
- password
- optional verification identifier

If X forces a manual interactive login challenge, cron execution on Railway will not be able to complete that step.

In that case you have two options:

1. Keep using credential-based login and add the right `X_LOGIN_IDENTIFIER_*` variable if the challenge is an identifier prompt.
2. Seed the browser profile locally first, then copy the resulting profile data into the mounted Railway volume before running cron jobs.

This repo does not yet include an automated “upload local profile into Railway volume” workflow.

## Good first deploy

Use this command first:

```text
pnpm railway:scheduler:dry-run
```

Once that works, switch the start command to:

```text
pnpm railway:scheduler
```
