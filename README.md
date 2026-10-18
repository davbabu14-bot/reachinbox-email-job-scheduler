# ReachInbox Email Scheduler & Notification Platform (V2)

A distributed, multi-tenant email scheduling and delivery system built with **TypeScript**, **Express**, **BullMQ**, **Redis**, **PostgreSQL (Prisma ORM)**, **Elasticsearch**, and **React (Vite + Tailwind CSS)**. 

The application implements enterprise messaging patterns including the **Transactional Outbox**, **exact BullMQ delayed scheduling**, **Redis-backed sliding-window rate limiting**, **live Slack OAuth 2.0 notifications**, and **multi-tenant full-text search**.

---

## Table of Contents

- [System Architecture](#system-architecture)
- [Key Architectural Highlights & Reliability Guarantees](#key-architectural-highlights--reliability-guarantees)
  - [Transactional Outbox Pattern](#1-transactional-outbox-pattern)
  - [Delayed Scheduling (Zero Crons)](#2-delayed-scheduling-zero-crons)
  - [Worker Downtime & Restart Recovery](#3-worker-downtime--restart-recovery)
  - [Delivery Semantics & Idempotency Limitations](#4-delivery-semantics--idempotency-limitations)
  - [Configurable Concurrency & Rate Limiting](#5-configurable-concurrency--rate-limiting)
  - [Real Slack Alert Notifications with Deduplication](#6-real-slack-alert-notifications-with-deduplication)
  - [Elasticsearch Multi-Tenant Search](#7-elasticsearch-multi-tenant-search)
  - [1,000-Job Load Test Results](#8-1000-job-load-test-results)
- [Prerequisites & Infrastructure](#prerequisites--infrastructure)
- [Environment Configuration](#environment-configuration)
- [Quick Start Guide](#quick-start-guide)
- [Bull Board Queue Dashboard](#bull-board-queue-dashboard)
- [Automated Verification & Test Suites](#automated-verification--test-suites)
- [Repository Structure](#repository-structure)

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Client Layer (React / Vite)                           │
│  - Port 5173 (Dev) / Production SPA Build (dist/)                               │
│  - Figma Dark Navy Theme (#14121f), Google GIS Authentication, Live Mailbox     │
└────────────────────────┬────────────────────────────────────────┬───────────────┘
                         │ Proxy /api                             │ Proxy /admin
                         ▼                                        ▼
┌──────────────────────────────────────────────┐        ┌─────────────────────────┐
│        V2 REST API Server (Port 3001)        │        │ Bull Board Admin UI     │
│  - Express / TypeScript                      │        │ - /admin/queues         │
│  - Google Session Auth (Redis Session Store) │        │ - Real-time queue view  │
│  - Bulk Email Ingestion & Outbox Writer      │        └────────────┬────────────┘
│  - Multi-Tenant Elasticsearch Search API     │                     │
│  - Slack OAuth 2.0 Callback & Integrations   │                     │
└──────────────┬───────────────────────────────┘                     │
               │                                                     │
       Atomic  │ Dual-Write                                          │
       Tx      │ Protection                                          │
               ▼                                                     │
┌──────────────────────────────┐       Enqueue Delayed Jobs          │
│ PostgreSQL (Prisma ORM)      │──────────────────────────────┐      │
│ - users, senders, emails     │                              │      │
│ - email_outbox (source-of-   │                              ▼      ▼
│   truth for pending jobs)    │                    ┌─────────────────────────┐
│ - slack_integrations         │                    │ Redis 7 (In-Memory)     │
└──────────────┬───────────────┘                    │ - bull:email-scheduler- │
               │                                    │   v2 (Delayed ZSet)     │
               │ Outbox Polling Loop                │ - Hourly Rate Limiters  │
               │ (startOutboxDispatcher)            │ - Slack Dedup Locks     │
               ▼                                    │ - Session Store         │
┌──────────────────────────────┐                    └────────────┬────────────┘
│ Transactional Outbox Worker  │                                 │
│ - Scans PENDING outbox rows  │                                 │ Job Dispatch
│ - Transitions to ENQUEUED    │                                 ▼
└──────────────────────────────┘                    ┌─────────────────────────┐
                                                    │ V2 Email Worker Process │
                                                    │ - Evaluates Rate Limits │
                                                    │ - Postpones on Quota    │
                                                    │ - Dispatches to SMTP    │
                                                    └────────────┬────────────┘
                                                                 │
                                     ┌───────────────────────────┴───────────────────────────┐
                                     ▼                                                       ▼
                      ┌──────────────────────────────┐                        ┌──────────────────────────────┐
                      │ Ethereal SMTP Server         │                        │ Slack Web API                │
                      │ - Transports test emails     │                        │ - chat.postMessage           │
                      │ - Returns web preview URLs   │                        │ - Rich Block Kit alerts      │
                      └──────────────────────────────┘                        └──────────────────────────────┘
```

---

## Key Architectural Highlights & Reliability Guarantees

### 1. Transactional Outbox Pattern
Direct dual-writes across separate network stores (e.g. inserting into PostgreSQL and immediately pushing to Redis) inevitably lead to inconsistency during network partitions or crashes. 

ReachInbox solves this using the **Transactional Outbox Pattern**:
- Every scheduling request (`/api/v2/schedule` and `/api/v2/schedule/bulk`) writes the `Email` record and an `EmailOutbox` record within the **exact same PostgreSQL ACID transaction**.
- A decoupled outbox dispatcher (`src/services/outboxDispatcher.ts`) continuously queries `PENDING` outbox entries in bounded batches, registers them into BullMQ with deterministic job IDs (`outbox-${emailId}`), and transitions their database status to `ENQUEUED`.
- If Redis is unavailable when an email is created, the email is never dropped; the outbox dispatcher automatically reconciles and enqueues it once Redis reconnects.

### 2. Delayed Scheduling (Zero Crons)
- The platform contains **zero cron jobs** or polling intervals for triggering sends.
- Emails are scheduled using BullMQ's native delayed job mechanism (`bull:email-scheduler-v2:delayed`), which stores jobs in a Redis sorted set indexed by execution timestamp:
  $$\text{score} = \text{scheduledAtTimestampMs}$$
- When the execution timestamp arrives, Redis and BullMQ move the job to the active processing stream with millisecond accuracy.

### 3. Worker Downtime & Restart Recovery
- The worker process (`src/worker/emailWorker.ts`) is completely stateless with respect to scheduled jobs.
- If the worker process is killed, stopped for maintenance, or crashed, **zero jobs are lost**. All delayed jobs remain persisted in Redis AOF/RDB storage.
- When the worker restarts, BullMQ immediately re-attaches to the delayed sorted set and resumes execution without missing jobs.
- If Redis were to experience catastrophic data loss, the PostgreSQL outbox table retains the authoritative record, allowing complete queue reconstruction.

### 4. Delivery Semantics & Idempotency Limitations
> **Distributed Systems Trade-off:** Across external network boundaries (SMTP, Slack, Redis, PostgreSQL), **guaranteed exactly-once external delivery is physically impossible** across arbitrary crash windows (the Two Generals' Problem).

ReachInbox implements **at-least-once delivery with idempotent application semantics**:
1. **Status Transitions:** Email lifecycle transitions from `SCHEDULED` $\to$ `PROCESSING` $\to$ `SENT` (or `FAILED`).
2. **Crash Window:** If a worker process dies *after* the external SMTP server accepts the message but *before* the worker commits the `SENT` update to PostgreSQL, the job may be re-attempted upon lock recovery.
3. **MTA Deduplication:** To protect recipient inboxes against duplicate delivery in crash scenarios, every outgoing email includes a deterministic `Message-ID` header derived from the unique outbox record ID (`<outbox-${id}@reachinbox.local>`), allowing recipient Mail Transfer Agents to deduplicate incoming messages.

### 5. Configurable Concurrency & Rate Limiting
- **Worker Concurrency:** Configured via `WORKER_CONCURRENCY` (default: 5 concurrent workers per node), enabling horizontal scaling.
- **Inter-Send Spacing:** A configurable minimum delay (`MIN_INTER_SEND_DELAY_MS`, default: 2,000ms) enforced per sender to prevent spam flagging.
- **Hourly Quota Enforcement:** Senders specify an `hourlyLimit` (default: 50/hr). The worker atomically queries and reserves capacity in Redis before sending:
  - If quota is exceeded, the worker **does not drop or fail the job**. Instead, the job is cleanly postponed in BullMQ using `job.moveToDelayed(now + retryAfterMs)` and preserved in `SCHEDULED` state for the next hour window.

### 6. Real Slack Alert Notifications with Deduplication
- When a sender exceeds their hourly rate limit, the worker dynamically evaluates whether the sender's owning user has a connected Slack workspace.
- If connected, the worker compiles a rich Block Kit alert and posts it to the configured channel via the Slack Web API (`chat.postMessage`).
- **Atomic Deduplication:** To prevent alert flooding when hundreds of emails for the same sender hit quota simultaneously, the worker acquires an atomic Redis lock:
  $$\text{Key: } \texttt{slack:alert:dedup:\{senderId\}:\{hourWindow\}}, \quad \text{TTL: } 3600\text{s}$$
  Subsequent rate-limit events for the same sender within that hour are suppressed, guaranteeing at most one Slack alert per sender per hour.

### 7. Elasticsearch Multi-Tenant Search
- High-performance full-text search across subject, body, and recipient fields.
- **Strict Tenant Scoping:** Every Elasticsearch query enforces a mandatory `term` filter on `userId`, guaranteeing zero cross-tenant data leakage.
- **High-Throughput Ingestion:** Configured with `refresh: false` on bulk indexing to prevent Lucene segment thrashing during 1,000+ email ingestion runs.

### 8. 1,000-Job Load Test Results
The scheduling pipeline was tested end-to-end with 1,000 unique emails scheduled in 4 bounded batches of 250:
- **Total Ingestion Time:** 46.02 seconds for 1,000 records.
- **PostgreSQL Persistence:** 1,000 / 1,000 `Email` records verified.
- **Transactional Outbox:** 1,000 / 1,000 `EmailOutbox` records transitioned to `ENQUEUED`.
- **BullMQ Queue Verification:** 1,000 jobs held in `delayed` state (48 hours in future, 0 premature sends).
- **Worker Downtime Survival:** 100% of jobs survived simulated worker downtime.
- **Safe Cleanup:** All 1,000 test jobs and records removed in 426ms.

---

## Prerequisites & Infrastructure

| Dependency | Minimum Version | Notes |
| :--- | :--- | :--- |
| **Node.js** | ≥ 18.0.0 | Tested on Node v20/v22 |
| **npm** | ≥ 9.0.0 | Bundled with Node.js |
| **Docker** | ≥ 20.10 | Required for PostgreSQL, Redis, Elasticsearch |
| **Docker Compose** | ≥ 2.0 | Used to manage local infrastructure |

### Starting Supporting Services via Docker

Ensure your local Docker containers are running:

```powershell
# Redis 7 on port 6379
docker run -d --name reachinbox-redis -p 6379:6379 redis:7-alpine

# PostgreSQL 16 on port 5432
docker run -d --name reachinbox-postgres -p 5432:5432 -e POSTGRES_DB=reachinbox -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres postgres:16-alpine

# Elasticsearch 8 on port 9200
docker run -d --name reachinbox-elasticsearch -p 9200:9200 -e "discovery.type=single-node" -e "xpack.security.enabled=false" docker.elastic.co/elasticsearch/elasticsearch:8.17.0
```

### Database Initialization

```powershell
# Generate Prisma Client
npm run prisma:generate

# Push database schema to PostgreSQL
npm run prisma:push
```

---

## Environment Configuration

Copy `.env.example` to `.env` in the project root:

```powershell
cp .env.example .env
```

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `PORT` | Legacy API Server port | `3000` |
| `API_V2_PORT` | Modern TypeScript V2 API port | `3001` |
| `NODE_ENV` | Environment mode (`development`/`production`) | `development` |
| `CLIENT_URL` | Frontend client origin (CORS) | `http://localhost:5173` |
| `REDIS_URL` | Redis connection URL | `redis://127.0.0.1:6379` |
| `DATABASE_URL` | PostgreSQL connection URL | `postgresql://postgres:postgres@127.0.0.1:5432/reachinbox?schema=public` |
| `ENCRYPTION_KEY` | 32-byte hex key for encrypting tokens at rest | Generate via `crypto.randomBytes(32).toString('hex')` |
| `SESSION_SECRET` | Secret key for signed session cookies | Secure random string |
| `GOOGLE_CLIENT_ID`| Google Cloud OAuth Client ID (Web Application) | `your_client_id.apps.googleusercontent.com` |
| `SLACK_CLIENT_ID` | Slack App Client ID | `your_slack_client_id` |
| `SLACK_CLIENT_SECRET` | Slack App Client Secret | `your_slack_client_secret` |
| `SLACK_SIGNING_SECRET`| Slack App Signing Secret | `your_slack_signing_secret` |
| `SLACK_REDIRECT_URI` | Slack OAuth callback URL | `http://localhost:3001/api/v2/slack/callback` |
| `ELASTICSEARCH_NODE` | Elasticsearch node URL | `http://127.0.0.1:9200` |
| `WORKER_CONCURRENCY` | Concurrent worker job concurrency | `5` |
| `MIN_INTER_SEND_DELAY_MS` | Minimum delay between sends per sender | `2000` |
| `DEFAULT_HOURLY_LIMIT` | Default fallback hourly quota per sender | `50` |

### Frontend Configuration

Copy `frontend/.env.example` to `frontend/.env`:

```powershell
cp frontend/.env.example frontend/.env
```

Set `VITE_GOOGLE_CLIENT_ID` to your Google Cloud Web Client ID.

---

## Quick Start Guide

### 1. Compile the TypeScript Backend
```powershell
npm run build
```

### 2. Start the Modern V2 Services
In separate terminal windows:

```powershell
# Terminal 1: Modern V2 API Server (Port 3001)
npm run start:v2

# Terminal 2: Modern V2 Email Worker Process (Queue: email-scheduler-v2)
npm run worker:v2

# Terminal 3: Vite React Frontend (Port 5173)
npm run frontend:dev
```

### 3. Open the Application
Navigate to **`http://localhost:5173`** in your browser.

- Sign in using the Google Sign-In button.
- Click **"Compose"** to schedule an email or upload a CSV/TXT list of recipients.
- Inspect real-time status in **Scheduled** and **Sent** mailboxes.

---

## Bull Board Queue Dashboard

Bull Board provides real-time monitoring of BullMQ queues:
- **URL:** `http://127.0.0.1:3001/admin/queues` (or via Vite proxy at `http://localhost:5173/admin/queues`)
- Inspect Active, Waiting, Completed, Failed, and **Delayed** jobs.
- Directly monitor job progress, return values (including Ethereal preview URLs), and retry delayed jobs.

---

## Automated Verification & Test Suites

The repository contains automated verification suites:

```powershell
# 1. Phase 3A Backend Integration Suite (8/8 Categories Passing)
# Verifies ES init, search scoping, session auth, Slack OAuth CSRF, Bull Board, and rate limits
node scratch/test-phase3a-suite.js

# 2. Phase 3B Frontend Verification Suite (46/46 Tests Passing)
# Verifies build bundles, recipient parsing, route contracts, and Figma compliance
node scratch/test-phase3b-suite.js

# 3. 1,000-Email Scale and Persistence Test
# Verifies bulk outbox transaction, BullMQ delayed queueing, and worker restart survival
node scratch/test-1000-scheduled-emails.js

# 4. Hourly Rate-Limit & Slack Alert Test
# Verifies quota postponement, real Slack API message dispatch (ts), and Redis deduplication
node scratch/test-rate-limit-slack-alert.js

# 5. Session Persistence Test
# Verifies Redis session storage, Set-Cookie attributes, and refresh persistence
node scratch/test-session-persistence.js
```

---

## Repository Structure

```
reachinbox-scheduler/
├── .env.example                     # Environment template with placeholders
├── .gitignore                       # Clean Git exclusion rules
├── package.json                     # Root scripts and server dependencies
├── tsconfig.json                    # Backend TypeScript configuration
├── prisma/
│   └── schema.prisma                # PostgreSQL data models (User, Sender, Email, Outbox, Slack)
├── frontend/                        # React / Vite SPA
│   ├── .env.example                 # Frontend client ID template
│   ├── index.html                   # HTML entry point with Google GIS SDK
│   ├── package.json                 # Frontend dependencies (React 19, Tailwind CSS)
│   ├── vite.config.ts               # Vite configuration with API and Bull Board proxies
│   └── src/
│       ├── api/client.ts            # Typed API client with credentials
│       ├── components/              # Sidebar, Header, ComposeModal, EmailList, SlackModal
│       └── types/                   # TypeScript interfaces
├── src/                             # Backend TypeScript source
│   ├── api/
│   │   ├── bullBoard.ts             # Bull Board dashboard configuration
│   │   ├── middleware/auth.ts       # Redis-backed session middleware
│   │   ├── routes.ts                # Express V2 REST endpoints
│   │   └── server.ts                # V2 server startup and outbox polling loop
│   ├── config/                      # Database, Redis, Elasticsearch, and Zod env loaders
│   ├── queue/                       # Shared BullMQ queue instance
│   ├── services/                    # Email, Outbox, Rate Limiter, Mailer, Search, Slack, Sender
│   ├── utils/crypto.ts              # AES-256-GCM token and secret encryption
│   └── worker/emailWorker.ts        # BullMQ email processor with rate-limit logic
└── scratch/                         # Automated verification and load-testing test harnesses
    ├── test-phase3a-suite.js        # Phase 3A verification suite
    ├── test-phase3b-suite.js        # Phase 3B verification suite
    ├── test-1000-scheduled-emails.js# 1,000-email scale load test
    ├── test-rate-limit-slack-alert.js# Live rate-limit Slack alert test
    └── test-session-persistence.js  # Session persistence and cookie test
```

---

## License

This project is licensed under the ISC License.
