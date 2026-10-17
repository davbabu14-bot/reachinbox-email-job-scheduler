'use strict';

/**
 * ReachInbox Scheduler – Professional SaaS Dashboard
 *
 * Refresh strategy: setInterval (10 s). No cron jobs, no node-cron.
 * Security:         All dynamic job data is escaped via escHtml() to prevent XSS.
 * Navigation:       Section-based routing driven by URL hash (#compose, #scheduled, #sent, #failed).
 */

const API_BASE = '';        // Same origin — Express serves this static dashboard
const REFRESH_MS = 10_000; // 10-second background polling via setInterval

// ── DOM Helpers ───────────────────────────────────────────────────────────────
/** @param {string} sel @returns {HTMLElement|null} */
const $ = (sel) => document.querySelector(sel);

/**
 * Escapes HTML characters to prevent XSS when inserting dynamic text.
 * @param {unknown} val
 * @returns {string}
 */
function escHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Formats an ISO date/time string for tabular display.
 * @param {string|null} iso
 * @returns {string}
 */
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

// ── Navigation & Views ────────────────────────────────────────────────────────
const SECTIONS = {
  compose: {
    title: 'Compose Email',
    subtitle: 'Schedule an email for future delivery via Ethereal SMTP',
  },
  scheduled: {
    title: 'Scheduled Emails',
    subtitle: 'Jobs queued in Redis waiting for their scheduled delivery time',
  },
  sent: {
    title: 'Sent Emails',
    subtitle: 'Completed jobs — inspect captured messages via Ethereal preview links',
  },
  failed: {
    title: 'Failed Emails',
    subtitle: 'Jobs that encountered delivery errors after retry attempts',
  },
};

/**
 * Switches the active view, updates sidebar active states, and synchronises the URL hash.
 * @param {string} section
 * @param {boolean} updateHash
 */
function navigateTo(section, updateHash = true) {
  const target = SECTIONS[section] ? section : 'compose';

  // 1. Update navigation links in sidebar
  document.querySelectorAll('.nav-item').forEach((item) => {
    const isCurrent = item.dataset.section === target;
    item.classList.toggle('active', isCurrent);
    if (isCurrent) {
      item.setAttribute('aria-current', 'page');
    } else {
      item.removeAttribute('aria-current');
    }
  });

  // 2. Toggle content sections
  document.querySelectorAll('.content-section').forEach((sec) => {
    sec.classList.toggle('active', sec.id === `section-${target}`);
  });

  // 3. Update topbar heading
  const titleEl = $('#page-title');
  const subEl = $('#page-subtitle');
  if (titleEl && SECTIONS[target]) titleEl.textContent = SECTIONS[target].title;
  if (subEl && SECTIONS[target]) subEl.textContent = SECTIONS[target].subtitle;

  // 4. Synchronise window hash
  if (updateHash && window.location.hash !== `#${target}`) {
    window.location.hash = target;
  }

  // 5. Close mobile drawer if open
  closeMobileMenu();
}

/** Wire navigation event listeners */
function initNavigation() {
  // Read initial hash on load (e.g. /#sent -> display Sent view)
  const initialHash = (window.location.hash || '').replace(/^#\/?/, '').toLowerCase();
  navigateTo(initialHash || 'compose', false);

  // Handle browser Back / Forward navigation
  window.addEventListener('hashchange', () => {
    const currentHash = (window.location.hash || '').replace(/^#\/?/, '').toLowerCase();
    navigateTo(currentHash || 'compose', false);
  });

  // Sidebar link clicks
  document.querySelectorAll('.nav-item').forEach((link) => {
    link.addEventListener('click', (e) => {
      const section = link.dataset.section;
      if (section) {
        e.preventDefault();
        navigateTo(section, true);
      }
    });
  });

  // Summary KPI card clicks (jump from Compose directly to that job section)
  const cardScheduled = $('.stat-card--scheduled');
  const cardSent = $('.stat-card--sent');
  const cardFailed = $('.stat-card--failed');

  const bindCard = (el, sec) => {
    if (!el) return;
    el.addEventListener('click', () => navigateTo(sec, true));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigateTo(sec, true);
      }
    });
  };

  bindCard(cardScheduled, 'scheduled');
  bindCard(cardSent, 'sent');
  bindCard(cardFailed, 'failed');
}

// ── Mobile Menu ───────────────────────────────────────────────────────────────
const mobileMenuBtn = $('#mobile-menu-btn');
const sidebar = $('#sidebar');
const sidebarOverlay = $('#sidebar-overlay');

function toggleMobileMenu() {
  if (!sidebar) return;
  const isOpen = sidebar.classList.toggle('open');
  if (sidebarOverlay) sidebarOverlay.classList.toggle('open', isOpen);
  if (mobileMenuBtn) mobileMenuBtn.setAttribute('aria-expanded', String(isOpen));
}

function closeMobileMenu() {
  if (sidebar) sidebar.classList.remove('open');
  if (sidebarOverlay) sidebarOverlay.classList.remove('open');
  if (mobileMenuBtn) mobileMenuBtn.setAttribute('aria-expanded', 'false');
}

if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', toggleMobileMenu);
if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeMobileMenu);

// ── Redis Health Indicator ────────────────────────────────────────────────────
async function checkHealth() {
  const badge = $('#status-badge');
  if (!badge) return;

  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const data = await res.json();
    if (data.redis === 'connected') {
      badge.className = 'redis-indicator redis-indicator--ok';
      badge.innerHTML = '<span class="redis-dot" aria-hidden="true"></span><span class="redis-label">Redis Connected</span>';
    } else {
      throw new Error(data.error || 'Redis disconnected');
    }
  } catch {
    badge.className = 'redis-indicator redis-indicator--error';
    badge.innerHTML = '<span class="redis-dot" aria-hidden="true"></span><span class="redis-label">Redis Disconnected</span>';
  }
}

// ── Compose Form ──────────────────────────────────────────────────────────────
function setFormMessage(text, type = '') {
  const el = $('#form-message');
  if (!el) return;
  el.textContent = text;
  el.className = 'form-message ' + type;
}

function setSubmitState(loading) {
  const btn = $('#submit-btn');
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading
    ? '<span class="spinner" aria-hidden="true"></span> Scheduling…'
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="22" y1="2" x2="11" y2="13"/>
        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
      </svg>
      Schedule Email`;
}

/** Enforces that the datetime-local picker only allows future timestamps (now + 1 min) */
function updateMinDatetime() {
  const picker = $('#scheduledAt');
  if (!picker) return;
  const now = new Date(Date.now() + 60_000);
  const offset = now.getTimezoneOffset() * 60_000;
  const local = new Date(now - offset).toISOString().slice(0, 16);
  picker.setAttribute('min', local);
}

const scheduleForm = $('#schedule-form');
if (scheduleForm) {
  scheduleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormMessage('');

    const toInput          = $('#to');
    const subjectInput     = $('#subject');
    const bodyInput        = $('#body');
    const scheduledAtInput = $('#scheduledAt');

    const to          = toInput ? toInput.value.trim() : '';
    const subject     = subjectInput ? subjectInput.value.trim() : '';
    const body        = bodyInput ? bodyInput.value.trim() : '';
    const scheduledAt = scheduledAtInput ? scheduledAtInput.value : '';

    // Client-side validation matching server constraints
    if (!to || !subject || !body || !scheduledAt) {
      setFormMessage('All fields are required.', 'error');
      return;
    }

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(to)) {
      setFormMessage('Please enter a valid recipient email address.', 'error');
      return;
    }

    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      setFormMessage('Invalid scheduled date/time.', 'error');
      return;
    }

    if (scheduledDate <= new Date()) {
      setFormMessage('Scheduled time must be at least 1 minute in the future.', 'error');
      return;
    }

    setSubmitState(true);

    try {
      const res = await fetch(`${API_BASE}/api/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to,
          subject,
          body,
          scheduledAt: scheduledDate.toISOString(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setFormMessage(data.error || 'Failed to schedule email.', 'error');
        return;
      }

      setFormMessage(
        `✓ Email scheduled for ${fmtDate(data.scheduledAt)} (Job #${data.id})`,
        'success'
      );

      scheduleForm.reset();
      updateMinDatetime();

      // Immediately refresh jobs and counts across dashboard
      await loadJobs();
    } catch {
      setFormMessage('Network error. Is the server running?', 'error');
    } finally {
      setSubmitState(false);
    }
  });
}

// ── Job Table Rendering ───────────────────────────────────────────────────────
const STATUS_LABELS = {
  delayed:   'Scheduled',
  active:    'Processing',
  waiting:   'Waiting',
  completed: 'Sent',
  failed:    'Failed',
};

function statusPill(status) {
  const label = STATUS_LABELS[status] || status;
  return `<span class="status-pill status-${escHtml(status)}">${escHtml(label)}</span>`;
}

/**
 * Builds HTML table rows for a single job item.
 * @param {object} job
 * @param {'scheduled'|'sent'|'failed'} type
 * @returns {string}
 */
function renderJobRow(job, type) {
  const timeDisplay = (() => {
    if (job.status === 'completed') return fmtDate(job.finishedAt);
    if (job.status === 'failed')    return fmtDate(job.finishedAt || job.processedAt);
    return fmtDate(job.scheduledAt);
  })();

  const previewAction = job.previewUrl
    ? `<a href="${escHtml(job.previewUrl)}" target="_blank" rel="noopener noreferrer" class="preview-link" title="Open Ethereal email preview">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/>
          <line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
        <span>View in Ethereal</span>
      </a>`
    : '<span class="cell-time">—</span>';

  const mainRow = `
    <tr>
      <td class="cell-to" title="${escHtml(job.to)}">${escHtml(job.to)}</td>
      <td class="cell-subject" title="${escHtml(job.subject)}">${escHtml(job.subject)}</td>
      <td>${statusPill(job.status)}</td>
      <td class="cell-time">${escHtml(timeDisplay)}</td>
      <td class="cell-id">#${escHtml(String(job.id))}</td>
      <td class="cell-action">${previewAction}</td>
    </tr>
  `;

  // For failed jobs, render an extra detail row displaying the error reason
  const failedRow = job.failedReason
    ? `<tr class="failed-row">
        <td colspan="6">
          <div class="failed-reason" role="alert">
            <strong>Failure details:</strong> ${escHtml(job.failedReason)}
            ${job.attemptsMade ? ` (${escHtml(String(job.attemptsMade))} attempts made)` : ''}
          </div>
        </td>
      </tr>`
    : '';

  return mainRow + failedRow;
}

/**
 * Renders a full job table or an empty state into the specified container.
 * @param {string} containerId
 * @param {Array} jobs
 * @param {'scheduled'|'sent'|'failed'} type
 */
function renderList(containerId, jobs, type) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!jobs || !jobs.length) {
    const emptyConfig = {
      scheduled: {
        title: 'No scheduled emails',
        sub: 'Emails scheduled for future delivery will appear here.',
      },
      sent: {
        title: 'No sent emails yet',
        sub: 'Delivered jobs will appear here with an Ethereal inspection link.',
      },
      failed: {
        title: 'No failed emails',
        sub: 'Jobs that encounter unrecoverable errors will appear here with details.',
      },
    };
    const conf = emptyConfig[type] || { title: 'No jobs found', sub: '' };

    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
          </svg>
        </div>
        <div class="empty-title">${escHtml(conf.title)}</div>
        <p class="empty-sub">${escHtml(conf.sub)}</p>
      </div>`;
    return;
  }

  const timeHeader = type === 'sent'
    ? 'Delivered At'
    : type === 'failed'
      ? 'Attempted At'
      : 'Scheduled For';

  const rowsHtml = jobs.map((j) => renderJobRow(j, type)).join('');

  el.innerHTML = `
    <table class="job-table" aria-label="${escHtml(type)} email jobs">
      <thead>
        <tr>
          <th scope="col">Recipient</th>
          <th scope="col">Subject</th>
          <th scope="col">Status</th>
          <th scope="col">${escHtml(timeHeader)}</th>
          <th scope="col" class="col-id">Job ID</th>
          <th scope="col" class="cell-action">Preview / Action</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  `;
}

// ── Counts Synchroniser ───────────────────────────────────────────────────────
/**
 * Synchronises counts across BOTH the summary KPI cards and the sidebar badges.
 * Uses real live data from the backend. Never hardcodes or invents values.
 * @param {{ scheduled: number, sent: number, failed: number }} counts
 */
function updateCounts(counts) {
  const setEl = (id, val) => {
    const el = $(id);
    if (el) el.textContent = String(val);
  };

  // Summary KPI cards in Compose section
  setEl('#count-scheduled', counts.scheduled);
  setEl('#count-sent', counts.sent);
  setEl('#count-failed', counts.failed);

  // Navigation badges in Sidebar
  setEl('#nav-count-scheduled', counts.scheduled);
  setEl('#nav-count-sent', counts.sent);
  setEl('#nav-count-failed', counts.failed);
}

// ── Job Loader ────────────────────────────────────────────────────────────────
let isRefreshing = false;

/**
 * Fetches all jobs from the backend API, updates tables and counts.
 * @param {boolean} isManual
 */
async function loadJobs(isManual = false) {
  if (isRefreshing) return;
  isRefreshing = true;

  // Spin any active refresh button
  document.querySelectorAll('.btn-ghost').forEach((btn) => {
    btn.classList.add('is-refreshing');
  });

  try {
    const res = await fetch(`${API_BASE}/api/jobs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Scheduled = delayed + active + waiting
    const scheduled = [
      ...(data.delayed || []),
      ...(data.active  || []),
      ...(data.waiting || []),
    ];
    const sent   = data.completed || [];
    const failed = data.failed    || [];

    // Render each section table
    renderList('list-scheduled', scheduled, 'scheduled');
    renderList('list-sent', sent, 'sent');
    renderList('list-failed', failed, 'failed');

    // Synchronise live counts to cards and sidebar badges
    updateCounts({
      scheduled: scheduled.length,
      sent: sent.length,
      failed: failed.length,
    });

    // Update refresh timestamps in all panel headers
    const timeStr = `Refreshed: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    ['#last-refresh', '#last-refresh-sent', '#last-refresh-failed'].forEach((id) => {
      const el = $(id);
      if (el) el.textContent = timeStr;
    });
  } catch (err) {
    console.error('[Dashboard] Failed to load jobs:', err.message);
    const refreshEl = $('#last-refresh');
    if (refreshEl) refreshEl.textContent = 'Sync failed — check connection';
  } finally {
    isRefreshing = false;
    document.querySelectorAll('.btn-ghost').forEach((btn) => {
      btn.classList.remove('is-refreshing');
    });
  }
}

// ── Refresh Controls ──────────────────────────────────────────────────────────
function initRefreshButtons() {
  const refreshHandler = () => {
    loadJobs(true);
    checkHealth();
  };

  ['#global-refresh-btn', '#refresh-btn', '#refresh-btn-sent', '#refresh-btn-failed'].forEach((id) => {
    const btn = $(id);
    if (btn) btn.addEventListener('click', refreshHandler);
  });
}

// ── Initialisation ────────────────────────────────────────────────────────────
updateMinDatetime();
initNavigation();
initRefreshButtons();
checkHealth();
loadJobs();

// Auto-refresh every 10 seconds via setInterval — persistent, no cron jobs.
setInterval(() => {
  loadJobs();
  checkHealth();
}, REFRESH_MS);
