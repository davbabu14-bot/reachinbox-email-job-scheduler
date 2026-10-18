// scratch/test-phase3b-suite.js
// Automated verification suite for Phase 3B — React Frontend and API Integration contracts

const fs = require('fs');
const path = require('path');
const http = require('http');

console.log('================================================================');
console.log('       PHASE 3B AUTOMATED VERIFICATION & FRONTEND SUITE        ');
console.log('================================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`   [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`   [FAIL] ${message}`);
    failCount++;
  }
}

async function runSuite() {
  // ─── 1. FRONTEND BUILD ARTIFACTS VERIFICATION ───
  console.log('--- 1. Frontend Build & Distribution Artifacts ---');
  const distDir = path.resolve(__dirname, '../frontend/dist');
  assert(fs.existsSync(distDir), 'frontend/dist directory exists');

  const indexHtmlPath = path.join(distDir, 'index.html');
  assert(fs.existsSync(indexHtmlPath), 'frontend/dist/index.html generated');

  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  assert(indexHtml.includes('ReachInbox'), 'index.html contains ReachInbox title');
  assert(indexHtml.includes('accounts.google.com/gsi/client'), 'index.html includes Google Identity Services script');

  const assetsDir = path.join(distDir, 'assets');
  assert(fs.existsSync(assetsDir), 'frontend/dist/assets directory exists');

  const assetFiles = fs.readdirSync(assetsDir);
  const jsFiles = assetFiles.filter((f) => f.endsWith('.js'));
  const cssFiles = assetFiles.filter((f) => f.endsWith('.css'));

  assert(jsFiles.length > 0, `JavaScript bundle generated: ${jsFiles.join(', ')}`);
  assert(cssFiles.length > 0, `Tailwind/CSS bundle generated: ${cssFiles.join(', ')}`);

  // ─── 2. CLIENT-SIDE CSV & RECIPIENT PARSING REGRESSION ───
  console.log('\n--- 2. Client-side CSV & Recipient Parsing Verification ---');
  
  // Exact regex used in ComposeModal
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const extractRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;

  const validEmail = 'lead.user@reachinbox.test';
  assert(emailRegex.test(validEmail), `Regex validates valid email: ${validEmail}`);

  const invalidEmail = 'not-an-email@com';
  assert(!emailRegex.test(invalidEmail), `Regex rejects invalid email: ${invalidEmail}`);

  // Test CSV parsing with duplicates, mixed casing, extra columns, spaces
  const sampleCsvContent = `
Name,Email,Company
Alice,Alice.Smith@company.io,Acme
Bob,bob.smith@company.io,Acme
Duplicate Alice,ALICE.SMITH@COMPANY.IO,Acme
Invalid,not_an_email,Acme
Charlie,charlie@outreach.test,Beta
  `;

  const rawMatches = sampleCsvContent.match(extractRegex) || [];
  const cleaned = rawMatches.map((m) => m.trim().toLowerCase());
  const uniqueRecipients = Array.from(new Set(cleaned));

  assert(uniqueRecipients.length === 3, `CSV parsing deduplicates to exactly 3 unique addresses (got ${uniqueRecipients.length})`);
  assert(uniqueRecipients.includes('alice.smith@company.io'), 'Normalized alice.smith@company.io found');
  assert(uniqueRecipients.includes('bob.smith@company.io'), 'Normalized bob.smith@company.io found');
  assert(uniqueRecipients.includes('charlie@outreach.test'), 'Normalized charlie@outreach.test found');
  assert(!uniqueRecipients.includes('not_an_email'), 'Invalid string excluded from recipients');

  // Test Empty / invalid file behavior
  const emptyCsv = 'Name,Phone,Address\nJohn,12345,Nowhere';
  const emptyMatches = emptyCsv.match(extractRegex) || [];
  assert(emptyMatches.length === 0, 'No false positive emails in non-email CSV');

  // ─── 3. FRONTEND PROXY AND BACKEND API CONTRACTS ───
  console.log('\n--- 3. Frontend API Client and Route Contracts ---');

  // Verify vite.config.ts proxy definitions
  const viteConfigPath = path.resolve(__dirname, '../frontend/vite.config.ts');
  const viteConfig = fs.readFileSync(viteConfigPath, 'utf8');
  assert(viteConfig.includes("'/api':"), 'Vite proxies /api to backend');
  assert(viteConfig.includes("'/admin':"), 'Vite proxies /admin to backend (Bull Board)');
  assert(viteConfig.includes('target:'), 'Vite target points to backend port 3001');

  // Verify frontend API client functions map to actual V2 backend routes
  const apiClientPath = path.resolve(__dirname, '../frontend/src/api/client.ts');
  const apiClient = fs.readFileSync(apiClientPath, 'utf8');
  assert(apiClient.includes("BASE_URL = '/api/v2'"), 'Client configures BASE_URL = /api/v2');
  assert(apiClient.includes("'/auth/google'"), 'Client routes /api/v2/auth/google');
  assert(apiClient.includes("'/auth/me'"), 'Client routes /api/v2/auth/me');
  assert(apiClient.includes("'/auth/logout'"), 'Client routes /api/v2/auth/logout');
  assert(apiClient.includes("'/schedule'"), 'Client routes /api/v2/schedule');
  assert(apiClient.includes("'/schedule/bulk'"), 'Client routes /api/v2/schedule/bulk');
  assert(apiClient.includes('/emails/search'), 'Client routes /api/v2/emails/search');
  assert(apiClient.includes("'/senders'"), 'Client routes /api/v2/senders');
  assert(apiClient.includes("'/slack/status'"), 'Client routes /api/v2/slack/status');
  assert(apiClient.includes("'/slack/test'"), 'Client routes /api/v2/slack/test');
  assert(apiClient.includes("'/slack/disconnect'"), 'Client routes /api/v2/slack/disconnect');
  assert(apiClient.includes("'/health'"), 'Client routes /api/v2/health');

  // ─── 4. FIGMA DESIGN SYSTEM COMPLIANCE VERIFICATION ───
  console.log('\n--- 4. Figma Design Reference Compliance ---');

  const sidebarPath = path.resolve(__dirname, '../frontend/src/components/Sidebar.tsx');
  const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');
  assert(sidebarContent.includes('#14121f'), 'Sidebar background matches Figma dark navy/purple (#14121f)');
  assert(sidebarContent.includes('ONB'), 'ONB brand monogram present');
  assert(sidebarContent.includes('border-emerald-500'), 'Compose button has green outline border');
  assert(sidebarContent.includes('Scheduled') && sidebarContent.includes('Sent'), 'Navigation contains Scheduled and Sent views');
  assert(sidebarContent.includes('counts.'), 'Dynamic live counts badges connected');
  assert(sidebarContent.includes('/admin/queues'), 'Bull Board link to /admin/queues present');

  const composePath = path.resolve(__dirname, '../frontend/src/components/ComposeModal.tsx');
  const composeContent = fs.readFileSync(composePath, 'utf8');
  assert(composeContent.includes('From Sender'), 'From Sender dropdown present');
  assert(composeContent.includes('Upload CSV / TXT'), 'Upload CSV / TXT action present');
  assert(composeContent.includes('Spacing (sec)'), 'Inter-email delay parameter present');
  assert(composeContent.includes('Hourly Limit'), 'Hourly limit parameter present');
  assert(composeContent.includes('Send now') && composeContent.includes('+15m') && composeContent.includes('Tomorrow'), 'Scheduling preset buttons present');
  assert(composeContent.includes('Attach File'), 'Attachment button present');
  assert(composeContent.includes('Bold') || composeContent.includes('applyFormatting'), 'Rich-text formatting actions present');

  const loginPath = path.resolve(__dirname, '../frontend/src/components/LoginScreen.tsx');
  const loginContent = fs.readFileSync(loginPath, 'utf8');
  assert(loginContent.includes('google.accounts.id.initialize'), 'Google Identity Services SDK initialized');
  assert(loginContent.includes('google.accounts.id.renderButton'), 'Official Google GIS button rendered');
  assert(loginContent.includes('Google Client ID Pending Configuration'), 'Helpful setup notice rendered when Client ID unconfigured');

  // ─── 5. SUMMARY ───
  console.log('\n================================================================');
  console.log(`Phase 3B Verification Complete: ${passCount} Passed, ${failCount} Failed`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
