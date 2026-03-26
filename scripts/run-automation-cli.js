/**
 * Cron-friendly entrypoint (no web server required).
 * Usage: node scripts/run-automation-cli.js
 */
const fs = require('fs');
const path = require('path');

function loadOptionalEnv() {
  const envPath = path.join(__dirname, 'shopify-test', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    const k = m[1];
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadOptionalEnv();

const { runDailyAutomation } = require('../src/automation-runner');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'Output');
const LOCK_PATH = path.join(OUT_DIR, 'locks', 'automation.lock');
const SUPPLIER_LATEST = path.join(OUT_DIR, 'products_all.latest.json');
const SNAP_DIR = path.join(OUT_DIR, 'snapshots', 'supplier');
const REPORT_JSON = path.join(OUT_DIR, 'automation_last_run.json');
const REPORT_TXT = path.join(OUT_DIR, 'automation_last_run.txt');

function fmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? String(x) : '0';
}

function buildText(run) {
  const c = run.counts || {};
  return [
    'Automation run',
    `Started: ${run.started_at || '—'}`,
    `Finished: ${run.finished_at || '—'}`,
    `Result: ${run.ok ? 'OK' : 'FAILED'}`,
    '',
    'Summary',
    `- Supplier latest products: ${fmt(c.supplier_latest_products)}`,
    `- Supplier delta updated: ${fmt(c.supplier_delta_updated)}`,
    `- Drafted unpaired ACTIVE: ${fmt(c.drafted_unpaired_active)} (failed ${fmt(c.drafted_failures)})`,
    `- Variant sync OK: ${fmt(c.variant_sync_ok)} (failed ${fmt(c.variant_sync_failed)})`,
    ''
  ].join('\n');
}

(async () => {
  const loc = (process.env.SHOPIFY_LOCATION_ID || process.env.SHOPIFY_LOCATION_NAME || 'Al Quoz Industrial Area 4').trim();
  const run = await runDailyAutomation({
    lockPath: LOCK_PATH,
    supplierLatestPath: SUPPLIER_LATEST,
    snapshotDir: SNAP_DIR,
    shopifyLocationNameOrId: loc
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, JSON.stringify(run, null, 2), 'utf8');
  fs.writeFileSync(REPORT_TXT, buildText(run), 'utf8');

  console.log(buildText(run));
  process.exit(run.ok ? 0 : 2);
})().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});

