# ReachInbox Email Job Scheduler

A full-stack email scheduling application built with **Express**, **BullMQ**, **Redis**, and **Nodemailer**. It accepts email scheduling requests via a REST API, persists them as delayed jobs in Redis, and processes them in a separate worker process that sends the emails through Ethereal's fake SMTP service.

> **⚠ Test environment only.**
> All emails are captured by [Ethereal](https://ethereal.email) and are **never delivered to real recipients**. Each processed job returns a preview URL so you can inspect the email in your browser.

---

## Features

- **REST API** — schedule emails, list all jobs, and retrieve a single job by ID
- **BullMQ delayed jobs** — jobs are stored in Redis with an exact fire-at timestamp; no cron jobs anywhere in the codebase
- **Separate worker process** — server and worker run independently; stopping or restarting either does not lose queued jobs
- **Job persistence** — delayed jobs survive server *and* worker restarts because they live in Redis, not in memory
- **Ethereal SMTP** — `nodemailer.createTestAccount()` auto-generates a free test account on first worker start; a clickable preview URL is stored on every completed job
- **Dashboard** — single-page UI for scheduling emails and viewing Scheduled / Sent / Failed jobs, auto-refreshed every 10 seconds via `setInterval`
- **Input validation** — email format, required fields, and future-only dates enforced on both client and server
- **Graceful shutdown** — both processes drain in-flight jobs before exiting on `SIGTERM`/`SIGINT`

---

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│       API Server            │        │        Worker Process         │
│  src/server.js              │        │  src/worker.js               │
│                             │        │                               │
│  POST /api/schedule  ──────────────▶ Redis (BullMQ queue)           │
│  GET  /api/jobs             │  ◀──── │  Polls delayed jobs           │
│  GET  /api/jobs/:id         │        │  Calls sendMail()             │
│  GET  /api/health           │        │  Stores previewUrl in job     │
│                             │        │  returnvalue                  │
│  Serves public/ (dashboard) │        └──────────────────────────────┘
└─────────────────────────────┘                      │
           │                                         ▼
           ▼                              ┌──────────────────────┐
  ┌─────────────────┐                    │  Ethereal SMTP       │
  │  Browser /      │                    │  smtp.ethereal.email │
  │  Dashboard      │                    │  (fake, no delivery) │
  └─────────────────┘                    └──────────────────────┘
```

**Module layout:**

| File | Purpose |
|---|---|
| `src/queue.js` | Shared BullMQ `Queue` instance and IORedis connection config |
| `src/mailer.js` | Nodemailer transporter backed by Ethereal SMTP |
| `src/server.js` | Express REST API + static file serving |
| `src/worker.js` | BullMQ `Worker` that processes email jobs |
| `public/index.html` | Dashboard HTML |
| `public/style.css` | Dashboard styles |
| `public/app.js` | Dashboard JavaScript (fetch, tabs, auto-refresh) |

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js** ≥ 18 | `node --version` to check |
| **npm** ≥ 9 | bundled with Node |
| **Docker** | Used to run Redis locally |
| **Internet access** (worker only) | Required to create an Ethereal test account and send test emails |

---

## Installation

```powershell
# Clone or enter the project directory
cd C:\Users\admin\reachinbox-scheduler

# Install dependencies (already installed if node_modules/ exists)
npm install
```

---

## Environment Configuration

Create a `.env` file in the project root. A minimal working configuration needs no values at all — defaults are built in. Add only what you want to override:

```dotenv
# Redis connection URL (default shown)
REDIS_URL=redis://127.0.0.1:6379

# Optional fallback host/port
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# Optional — Express port (default: 3000)
PORT=3000

# Optional — Ethereal SMTP credentials
# If omitted, the worker auto-creates a free test account on startup.
# ETHEREAL_USER=your.ethereal.user@ethereal.email
# ETHEREAL_PASS=yourpassword
```

> **Never commit `.env` to Git.** It is covered by `.gitignore`.

---

## Starting Redis with Docker

The application requires a running Redis instance. Use the existing local container or create a new one configured with a named persistent volume and Redis AOF persistence:

```powershell
# Start the existing named container
docker start reachinbox-redis

# --- OR create it fresh (first time with persistent volume and AOF) ---
docker run -d --name reachinbox-redis -p 6379:6379 -v reachinbox-redis-data:/data redis:7-alpine redis-server --appendonly yes --maxmemory-policy noeviction

# Verify Redis is responding
docker exec reachinbox-redis redis-cli ping
# Expected output: PONG
```

---

## Running the Application

The API server and the worker are **separate processes**. Open two terminals and leave both running.

### Terminal 1 — API Server

```powershell
npm start
# Starts on http://localhost:3000 (or PORT from .env)
```

Expected output:
```
[Server] ReachInbox Scheduler   → http://localhost:3000
[Server] Dashboard              → http://localhost:3000/
[Server] Health check           → http://localhost:3000/api/health
```

### Terminal 2 — Email Worker

```powershell
npm run worker
# Connects to the same Redis queue and waits for delayed jobs
```

Expected output (first run with no Ethereal credentials in `.env`):
```
[Worker] Starting email worker process...
[Worker] Queue: "email-scheduler"   Redis: 127.0.0.1:6379
[Mailer] Ethereal test account created: abc123@ethereal.email
[Mailer] NOTE: emails are intercepted by Ethereal; no real delivery occurs.
```

> **Both processes must be running** for the end-to-end flow (schedule → send → view preview) to work. The API server can receive schedules while the worker is down; those jobs will be processed as soon as the worker starts again.

---

## Using the Dashboard

Open **http://localhost:3000** in your browser.

| Element | Description |
|---|---|
| **Status badge** (top right) | Shows `● Redis Connected` or `● Redis Disconnected` |
| **Schedule an Email** form | Fill in recipient, subject, body, and a future date/time, then click **Schedule Email** |
| **Scheduled tab** | Jobs waiting for their fire time (BullMQ state: `delayed`, `active`, `waiting`) |
| **Sent tab** | Completed jobs — click **View in Ethereal** to preview the captured email |
| **Failed tab** | Jobs that exhausted all 3 retry attempts — shows the failure reason |
| **↻ Refresh** button | Manually refresh the job list |
| **Auto-refresh** | Dashboard polls `/api/jobs` every **10 seconds** via `setInterval` |

---

## API Reference

### `POST /api/schedule`

Schedule a future email.

**Request body** (`Content-Type: application/json`):

```json
{
  "to": "recipient@example.com",
  "subject": "Hello from ReachInbox",
  "body": "This is your scheduled message.\n\nRegards,\nReachInbox",
  "scheduledAt": "2026-10-18T10:30:00.000Z"
}
```

**Validation rules:**
- `to` — required, must be a valid email address
- `subject` — required, non-empty string
- `body` — required, non-empty string
- `scheduledAt` — required, valid ISO 8601 date/time, **must be in the future**

**Success response** `201 Created`:

```json
{
  "id": "42",
  "message": "Email scheduled successfully.",
  "scheduledAt": "2026-10-18T10:30:00.000Z",
  "delayMs": 3600000
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Missing fields, invalid email, empty subject/body, past date |
| `503` | Redis unavailable |

---

### `GET /api/jobs`

Returns all jobs grouped by BullMQ state.

**Response** `200 OK`:

```json
{
  "delayed":   [ { "id": "1", "status": "delayed", "to": "...", "subject": "...", "scheduledAt": "...", "createdAt": "...", "processedAt": null, "finishedAt": null, "previewUrl": null, "failedReason": null, "attemptsMade": 0 } ],
  "active":    [],
  "waiting":   [],
  "completed": [ { "id": "2", "status": "completed", "previewUrl": "https://ethereal.email/message/...", "finishedAt": "...", ... } ],
  "failed":    [ { "id": "3", "status": "failed", "failedReason": "connect ECONNREFUSED", "attemptsMade": 3, ... } ]
}
```

---

### `GET /api/jobs/:id`

Returns a single job by its BullMQ ID.

**Success response** `200 OK` — same shape as a single entry from `GET /api/jobs`.

**Error responses:**

| Status | Condition |
|---|---|
| `404` | Job ID not found |
| `503` | Redis unavailable |

---

### `GET /api/health`

Confirms the server is running and Redis is reachable.

**Success response** `200 OK`:

```json
{
  "status": "ok",
  "redis": "connected",
  "timestamp": "2026-10-17T17:45:00.000Z"
}
```

**Degraded response** `503`:

```json
{
  "status": "degraded",
  "redis": "disconnected",
  "error": "...",
  "timestamp": "..."
}
```

---

## About Ethereal Email

[Ethereal](https://ethereal.email) is a **fake SMTP service** designed for testing. Key facts:

- Emails are **captured**, not forwarded to real inboxes.
- The worker logs the Ethereal preview URL to the console and stores it on the job's `returnvalue`.
- The dashboard displays a **"View in Ethereal"** link for every sent job.
- If `ETHEREAL_USER` and `ETHEREAL_PASS` are not set in `.env`, a fresh test account is automatically created each time the worker starts.

---

## Job Retention

Completed and failed jobs are **not deleted immediately**. Retention limits set in `src/queue.js`:

| State | Kept |
|---|---|
| Completed | Last **500** jobs |
| Failed | Last **200** jobs |

This ensures the dashboard always shows recent history without growing Redis indefinitely.

---

## Retry Policy

Failed jobs are retried automatically by BullMQ with **exponential back-off**:

| Attempt | Delay before retry |
|---|---|
| 1 → 2 | 5 seconds |
| 2 → 3 | 10 seconds |
| 3 (final) | job moves to `failed` state |

---

## npm Scripts

```powershell
npm start        # Start the API server (src/server.js)
npm run worker   # Start the email worker (src/worker.js)
npm run dev      # Alias for npm start (development)
```

---

## Security Notes

- `.env` is listed in `.gitignore` and will never be committed.
- `node_modules/` is also excluded from Git.
- All dynamic values rendered on the dashboard pass through `escHtml()` to prevent XSS.
- Credentials are read exclusively from environment variables — never hardcoded or logged.

---

## Dependencies

| Package | Version | Role |
|---|---|---|
| `express` | ^5.3.0 | HTTP server and routing |
| `bullmq` | ^6.3.16 | Redis-backed job queue |
| `ioredis` | ^6.0.0 | Redis client (used by BullMQ) |
| `nodemailer` | ^10.1.2 | SMTP email sending via Ethereal |
| `cors` | ^2.8.6 | Cross-Origin Resource Sharing |
| `dotenv` | ^18.0.8 | `.env` file loading |
