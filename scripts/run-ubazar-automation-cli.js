/**
 * Cron-friendly entrypoint for UBazar daily automation (no web server required).
 * Calls POST /api/ubazar/run on the running review server and exits with appropriate code.
 *
 * Usage: node scripts/run-ubazar-automation-cli.js
 *
 * The review server must be running (Passenger keeps it alive on cPanel).
 * Exit codes: 0 = success, 1 = error/exception, 2 = automation ran but reported failure.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');

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

const PORT = Number(process.env.PORT || process.env.REVIEW_PORT || 3001);

function postJson(port, path) {
  return new Promise((resolve, reject) => {
    const body = '{}';
    const req = http.request(
      { hostname: 'localhost', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (_) { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildText(run) {
  const c = run.counts || {};
  return [
    'UBazar automation run',
    `Started:  ${run.started_at || '—'}`,
    `Finished: ${run.finished_at || '—'}`,
    `Result:   ${run.ok ? 'OK' : 'FAILED'}`,
    '',
    'Summary',
    `- UBazar products scraped: ${c.ubazar_latest_products ?? 0}`,
    `- Supplier delta: +${c.supplier_delta_added ?? 0} added, ~${c.supplier_delta_updated ?? 0} updated, -${c.supplier_delta_removed ?? 0} removed`,
    `- Unpaired Gastronom set to DRAFT: ${c.drafted_unpaired_gastronom ?? 0} (failed ${c.drafted_unpaired_failed ?? 0})`,
    `- Mapped products activated: ${c.mapped_activated ?? 0}`,
    `- Mapped products drafted (unavailable): ${c.mapped_drafted ?? 0}`,
    `- Variant sync OK: ${c.variant_sync_ok ?? 0} (failed ${c.variant_sync_failed ?? 0})`,
    ''
  ].join('\n');
}

(async () => {
  console.log(`[ubazar-cron] Calling POST http://localhost:${PORT}/api/ubazar/run ...`);
  let result;
  try {
    result = await postJson(PORT, '/api/ubazar/run');
  } catch (e) {
    console.error(`[ubazar-cron] HTTP request failed: ${String(e.message || e)}`);
    process.exit(1);
  }

  const run = result.body;
  const text = buildText(typeof run === 'object' && run ? run : {});
  console.log(text);

  if (result.status !== 200 || (typeof run === 'object' && run && run.ok === false)) {
    const errs = (typeof run === 'object' && Array.isArray(run.errors)) ? run.errors : [];
    if (errs.length) console.error('Errors:\n' + errs.map((e) => `  - ${e}`).join('\n'));
    process.exit(2);
  }

  process.exit(0);
})().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
