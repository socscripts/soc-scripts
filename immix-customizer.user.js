/**
 * Immix auto-process telemetry collector + dashboard.
 *
 *   GET  /                     the dashboard (same as /dashboard)
 *   GET  /dashboard            live charts and per-operator tables
 *   GET  /api/summary?days=7   header: X-Api-Key  -> aggregated JSON
 *   POST /ingest               header: X-Api-Key  -> { "events": [ ... ] }
 *   GET  /export?days=7        header: X-Api-Key  -> CSV of every raw event
 *   GET  /health               liveness check
 *   GET  /debug                binding diagnostics, reveals no secret
 *
 * Writes are idempotent: event_id is unique and inserts use OR IGNORE, so a
 * client retry after a timeout that actually succeeded cannot double count.
 *
 * Days are bucketed using each event's own recorded timezone offset, so the
 * boundaries follow the operator's local midnight and survive DST changes.
 */

const MAX_EVENTS_PER_REQUEST = 200;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return withCors(new Response(null, { status: 204 }));
        }

        if (url.pathname === '/' || url.pathname === '/dashboard') {
            return new Response(DASHBOARD_HTML, {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        if (url.pathname === '/health') {
            return withCors(json({ ok: true }));
        }

        if (url.pathname === '/debug') {
            return withCors(json(await debugInfo(env)));
        }

        if (url.pathname === '/api/summary' && request.method === 'GET') {
            return withCors(await summary(request, env, url));
        }

        if (url.pathname === '/policy' && request.method === 'GET') {
            return withCors(await getPolicy(request, env, url));
        }

        if (url.pathname === '/api/policy' && request.method === 'POST') {
            return withCors(await setPolicy(request, env));
        }

        if (url.pathname === '/ingest' && request.method === 'POST') {
            return withCors(await ingest(request, env));
        }

        if (url.pathname === '/export' && request.method === 'GET') {
            return withCors(await exportCsv(request, env, url));
        }

        return withCors(json({ error: 'not found' }, 404));
    }
};

/* ---------------------------------------------------------------- helpers */

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function withCors(res) {
    const h = new Headers(res.headers);
    h.set('Access-Control-Allow-Origin', '*');
    h.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
    h.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    return new Response(res.body, { status: res.status, headers: h });
}

async function authorized(request, env) {
    const key = request.headers.get('X-Api-Key') || '';

    // env.INGEST_KEY is a plain string with a classic `wrangler secret put`.
    // With the newer Secrets Store binding it's an object and the value has
    // to be read with .get(). Support whichever this account has.
    let want = env.INGEST_KEY || '';
    if (want && typeof want.get === 'function') {
        want = await want.get();
    }
    want = want || '';

    if (!want || key.length !== want.length) return false;
    // constant-time-ish compare
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= key.charCodeAt(i) ^ want.charCodeAt(i);
    return diff === 0;
}

function num(v) {
    return typeof v === 'number' && isFinite(v) ? Math.round(v) : null;
}

/**
 * Writing a policy is an admin action. Agents hold INGEST_KEY inside the
 * userscript, so if that were also the write key an operator could read it
 * out and lift their own override. Configure a second secret named
 * ADMIN_KEY to close that gap. Until one exists this falls back to
 * INGEST_KEY so the feature works out of the box.
 */
async function adminAuthorized(request, env) {
    if (!env.ADMIN_KEY) return authorized(request, env);

    const key = request.headers.get('X-Api-Key') || '';
    let want = env.ADMIN_KEY;
    if (want && typeof want.get === 'function') want = await want.get();
    want = want || '';

    if (!want || key.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= key.charCodeAt(i) ^ want.charCodeAt(i);
    return diff === 0;
}

function str(v, max = 200) {
    if (v === null || v === undefined) return null;
    return String(v).slice(0, max);
}

// Local day for an event, derived from the offset the browser reported.
const LOCAL_DAY = "date((server_ts/1000) - (COALESCE(tz_offset_min,0)*60), 'unixepoch')";

/* ---------------------------------------------------------------- debug */

async function debugInfo(env) {
    const out = {
        db_binding_present: !!env.DB,
        ingest_key_binding_present: !!env.INGEST_KEY,
        ingest_key_style: 'missing',
        ingest_key_readable: false,
        ingest_key_length: 0,
        events_in_table: null
    };

    if (env.INGEST_KEY) {
        if (typeof env.INGEST_KEY === 'string') {
            out.ingest_key_style = 'plain string (classic secret)';
            out.ingest_key_readable = true;
            out.ingest_key_length = env.INGEST_KEY.length;
        } else if (typeof env.INGEST_KEY.get === 'function') {
            out.ingest_key_style = 'Secrets Store binding';
            try {
                const v = await env.INGEST_KEY.get();
                out.ingest_key_readable = typeof v === 'string' && v.length > 0;
                out.ingest_key_length = (v || '').length;
            } catch (err) {
                out.ingest_key_error = String(err).slice(0, 200);
            }
        } else {
            out.ingest_key_style = 'unrecognised binding type';
        }
    }

    if (env.DB) {
        try {
            const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first();
            out.events_in_table = r ? r.n : null;
        } catch (err) {
            out.db_error = String(err).slice(0, 200);
        }
    }

    return out;
}

/* ---------------------------------------------------------------- ingest */

async function ingest(request, env) {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);

    let body;
    try {
        body = await request.json();
    } catch (e) {
        return json({ error: 'bad json' }, 400);
    }

    const events = Array.isArray(body && body.events) ? body.events : null;
    if (!events) return json({ error: 'events array required' }, 400);
    if (events.length > MAX_EVENTS_PER_REQUEST) {
        return json({ error: 'too many events' }, 413);
    }
    if (events.length === 0) return json({ ok: true, accepted: 0 });

    const serverTs = Date.now();

    const stmt = env.DB.prepare(
        `INSERT OR IGNORE INTO events (
            event_id, type, user_id, user_name, user_role, device_id, session_id,
            client_ts, server_ts, tz_offset_min, script_version, page,
            duration_ms, wait_ms, queue_wait_ms, state, prev_state, mode,
            speed, queue_size, alarm_event_id, payload
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    const rows = [];
    for (const e of events) {
        if (!e || typeof e !== 'object') continue;
        const d = (e.data && typeof e.data === 'object') ? e.data : {};

        rows.push(stmt.bind(
            str(e.eventId, 64) || crypto.randomUUID(),
            str(e.type, 40) || 'unknown',
            str(e.userId, 64),
            str(e.userName, 120),
            str(e.userRole, 60),
            str(e.deviceId, 64),
            str(e.sessionId, 64),
            num(e.clientTs),
            serverTs,
            num(e.tzOffsetMin),
            str(e.scriptVersion, 20),
            str(e.page, 20),
            num(d.durationMs != null ? d.durationMs : d.prevStateMs),
            num(d.waitMs),
            num(d.queueWaitMs),
            str(d.state, 10),
            str(d.prevState, 10),
            str(d.mode, 10),
            str(d.speed, 10),
            num(d.queueSize),
            str(d.alarmEventId, 64),
            JSON.stringify(d).slice(0, 4000)
        ));
    }

    if (!rows.length) return json({ ok: true, accepted: 0 });

    try {
        await env.DB.batch(rows);
    } catch (err) {
        return json({ error: 'write failed', detail: String(err).slice(0, 200) }, 500);
    }

    return json({ ok: true, accepted: rows.length });
}

/* ---------------------------------------------------------------- policy */

// Polled by the userscript. Agents use the ordinary ingest key.
async function getPolicy(request, env, url) {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);

    const user = (url.searchParams.get('user') || '').slice(0, 64);
    if (!user) return json({ error: 'user required' }, 400);

    try {
        const row = await env.DB.prepare(
            'SELECT force_on, note, updated_at FROM policies WHERE user_id = ?'
        ).bind(user).first();

        return json({
            user_id:    user,
            force_on:   !!(row && row.force_on),
            note:       (row && row.note) || null,
            updated_at: (row && row.updated_at) || null
        });
    } catch (err) {
        // Table missing or unreadable: report no override rather than failing,
        // so a half-finished setup never locks anyone's toggle.
        return json({ user_id: user, force_on: false, note: null, updated_at: null });
    }
}

// Written from the dashboard.
async function setPolicy(request, env) {
    if (!(await adminAuthorized(request, env))) return json({ error: 'unauthorized' }, 401);

    let body;
    try {
        body = await request.json();
    } catch (e) {
        return json({ error: 'bad json' }, 400);
    }

    const user = str(body && body.user_id, 64);
    if (!user) return json({ error: 'user_id required' }, 400);

    const forceOn = (body && body.force_on) ? 1 : 0;

    try {
        await env.DB.prepare(
            `INSERT INTO policies (user_id, force_on, note, updated_at, updated_by)
             VALUES (?,?,?,?,?)
             ON CONFLICT(user_id) DO UPDATE SET
                force_on   = excluded.force_on,
                note       = excluded.note,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by`
        ).bind(user, forceOn, str(body.note, 200), Date.now(), str(body.updated_by, 60) || 'dashboard').run();
    } catch (err) {
        return json({ error: 'write failed', detail: String(err).slice(0, 200) }, 500);
    }

    return json({ ok: true, user_id: user, force_on: !!forceOn });
}

/* ---------------------------------------------------------------- summary */

async function summary(request, env, url) {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);

    const days  = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10)));
    const since = Date.now() - days * 86400000;

    // Ignore absurd stretches, e.g. someone left it off over a weekend.
    const MAX_STRETCH = 12 * 60 * 60 * 1000;

    // Optional single-operator filter. Empty means everyone.
    const user  = (url.searchParams.get('user') || '').slice(0, 64);
    const scope = 'server_ts >= ?' + (user ? ' AND user_id = ?' : '');
    const args  = user ? [since, user] : [since];

    const totalsQ = env.DB.prepare(
        `SELECT
            COUNT(DISTINCT user_id)                                  AS operators,
            SUM(type='alarm_session')                                AS alarms,
            AVG(CASE WHEN type='alarm_session' THEN duration_ms END) AS avg_alarm_ms,
            SUM(type='pickup' AND mode='auto')                       AS auto_pickups,
            SUM(type='pickup' AND mode='manual')                     AS manual_pickups,
            AVG(CASE WHEN type='pickup' AND mode='manual'
                     THEN wait_ms END)                               AS avg_wait_ms,
            AVG(CASE WHEN type='pickup' AND mode='manual'
                     THEN queue_wait_ms END)                         AS avg_queue_wait_ms,
            SUM(type='toggle' AND state='off')                       AS times_turned_off,
            SUM(type='override_blocked')                             AS blocked_overrides,
            SUM(type='toggle' AND state='on'
                AND json_extract(payload,'$.source')='schedule')     AS scheduled_ons
         FROM events WHERE ${scope}`
    ).bind(...args);

    const operatorsQ = env.DB.prepare(
        `SELECT
            user_id,
            COALESCE(MAX(user_name), user_id)                        AS operator,
            MAX(user_role)                                           AS role,
            SUM(type='alarm_session')                                AS alarms,
            AVG(CASE WHEN type='alarm_session' THEN duration_ms END) AS avg_alarm_ms,
            SUM(type='pickup' AND mode='auto')                       AS auto_pickups,
            SUM(type='pickup' AND mode='manual')                     AS manual_pickups,
            AVG(CASE WHEN type='pickup' AND mode='manual'
                     THEN wait_ms END)                               AS avg_wait_ms,
            AVG(CASE WHEN type='pickup' AND mode='manual'
                     THEN queue_wait_ms END)                         AS avg_queue_wait_ms,
            SUM(type='toggle' AND state='off')                       AS times_turned_off,
            SUM(type='override_blocked')                             AS blocked_overrides,
            SUM(CASE WHEN type='toggle' AND state='on' AND duration_ms < ?
                     THEN duration_ms END)                           AS ms_auto_off,
            MAX(server_ts)                                           AS last_seen,
            COUNT(DISTINCT device_id)                                AS devices
         FROM events WHERE ${scope}
         GROUP BY user_id
         ORDER BY alarms DESC, operator`
    ).bind(MAX_STRETCH, ...args);

    const dailyQ = env.DB.prepare(
        `SELECT
            ${LOCAL_DAY}                                             AS day,
            SUM(type='alarm_session')                                AS alarms,
            AVG(CASE WHEN type='alarm_session' THEN duration_ms END) AS avg_alarm_ms,
            SUM(type='pickup' AND mode='auto')                       AS auto_pickups,
            SUM(type='pickup' AND mode='manual')                     AS manual_pickups,
            AVG(CASE WHEN type='pickup' AND mode='manual'
                     THEN wait_ms END)                               AS avg_wait_ms
         FROM events WHERE ${scope}
         GROUP BY day ORDER BY day`
    ).bind(...args);

    const togglesQ = env.DB.prepare(
        `SELECT COALESCE(user_name, user_id) AS operator,
                server_ts, state, duration_ms, speed, queue_size
         FROM events
         WHERE type='toggle' AND ${scope}
         ORDER BY server_ts DESC LIMIT 50`
    ).bind(...args);

    const rosterQ = env.DB.prepare(
        `SELECT user_id, COALESCE(MAX(user_name), user_id) AS operator
         FROM events WHERE server_ts >= ?
         GROUP BY user_id ORDER BY operator`
    ).bind(since);

    try {
        const [totals, operators, daily, toggles, roster] =
            await env.DB.batch([totalsQ, operatorsQ, dailyQ, togglesQ, rosterQ]);

        // Separate from the batch: if the policies table has not been created
        // yet the dashboard should still render everything else.
        let policies = [];
        try {
            const pr = await env.DB.prepare(
                'SELECT user_id, force_on, note, updated_at FROM policies'
            ).all();
            policies = pr.results || [];
        } catch (err) {
            policies = [];
        }

        return json({
            generated_at:  Date.now(),
            range_days:    days,
            filtered_user: user || null,
            policies:      policies,
            admin_key_required: !!env.ADMIN_KEY,
            totals:        (totals.results && totals.results[0]) || {},
            operators:     operators.results || [],
            daily:         daily.results || [],
            toggles:       toggles.results || [],
            roster:        roster.results || []
        });
    } catch (err) {
        return json({ error: 'query failed', detail: String(err).slice(0, 300) }, 500);
    }
}

/* ---------------------------------------------------------------- export */

async function exportCsv(request, env, url) {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);

    const days  = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10)));
    const since = Date.now() - days * 86400000;

    const { results } = await env.DB.prepare(
        `SELECT e.*, COALESCE(o.full_name, e.user_name, e.user_id) AS operator
           FROM events e
           LEFT JOIN operators o ON o.user_id = e.user_id
          WHERE e.server_ts >= ?
          ORDER BY e.server_ts`
    ).bind(since).all();

    if (!results || !results.length) {
        return new Response('', { headers: { 'Content-Type': 'text/csv' } });
    }

    const cols = Object.keys(results[0]);
    const esc = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const lines = [cols.join(',')];
    for (const r of results) lines.push(cols.map((c) => esc(r[c])).join(','));

    return new Response(lines.join('\n'), {
        headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="immix-events-' + days + 'd.csv"'
        }
    });
}

/* ---------------------------------------------------------------- dashboard */

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auto Process - Operator Activity</title>
<style>
  :root {
    --bg:#10151c; --panel:#172029; --panel2:#1d2833; --line:#2a3744;
    --text:#dfe7ef; --muted:#8b9bab; --dim:#65788a;
    --accent:#4c9be8; --good:#5bb98c; --warn:#e0a33e; --bad:#d85a5a;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font:15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header {
    display:flex; align-items:baseline; gap:18px; flex-wrap:wrap;
    padding:22px 28px; border-bottom:1px solid var(--line); background:var(--panel);
  }
  header h1 { margin:0; font-size:19px; font-weight:600; letter-spacing:-.01em; }
  header .sub { color:var(--dim); font-size:13px; }
  .spacer { flex:1; }
  select, button {
    background:var(--panel2); color:var(--text); border:1px solid var(--line);
    border-radius:5px; padding:6px 11px; font-size:13px; font-family:inherit; cursor:pointer;
  }
  button:hover, select:hover { border-color:var(--accent); }
  main { padding:24px 28px 60px; max-width:1240px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px 18px; }
  .card .label { color:var(--muted); font-size:12px; margin-bottom:6px; }
  .card .value { font-family:var(--mono); font-size:27px; font-weight:600; letter-spacing:-.02em; }
  .card .note { color:var(--dim); font-size:12px; margin-top:4px; }
  h2 { font-size:14px; font-weight:600; color:var(--muted); margin:34px 0 12px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th {
    text-align:left; color:var(--muted); font-weight:500; font-size:12px;
    padding:0 10px 9px; border-bottom:1px solid var(--line); white-space:nowrap;
  }
  th.n, td.n { text-align:right; }
  td { padding:10px; border-bottom:1px solid rgba(42,55,68,.5); white-space:nowrap; }
  tr:last-child td { border-bottom:none; }
  td.n { font-family:var(--mono); }
  .who { font-weight:500; }
  .role { color:var(--dim); font-size:12px; }
  .chart { display:flex; align-items:flex-end; gap:8px; height:180px; padding-top:10px; }
  .bar { flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; gap:6px; min-width:0; }
  .bar .fill { width:100%; background:var(--accent); border-radius:3px 3px 0 0; min-height:2px; opacity:.85; }
  .bar .fill:hover { opacity:1; }
  .bar .cap { font-family:var(--mono); font-size:11px; color:var(--muted); }
  .bar .lab { font-size:11px; color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
  .pill { display:inline-block; padding:1px 7px; border-radius:3px; font-size:11px; font-family:var(--mono); }
  .pill.on { background:rgba(76,155,232,.16); color:var(--accent); }
  .pill.off { background:rgba(139,155,171,.14); color:var(--muted); }
  .good { color:var(--good); } .warn { color:var(--warn); } .bad { color:var(--bad); }
  .empty { color:var(--dim); padding:26px 0; text-align:center; }
  .search {
    width:100%; max-width:340px; margin-bottom:14px; padding:7px 11px;
    border-radius:5px; border:1px solid var(--line); background:var(--panel2);
    color:var(--text); font-family:inherit; font-size:13px;
  }
  .search:focus { outline:none; border-color:var(--accent); }
  th.sortable { cursor:pointer; user-select:none; }
  th.sortable:hover { color:var(--text); }
  th .arrow { color:var(--accent); font-size:10px; margin-left:3px; }
  tr.me td { background:rgba(76,155,232,.06); }
  .sw {
    display:inline-flex; align-items:center; gap:7px; cursor:pointer;
    border:1px solid var(--line); background:var(--panel2); color:var(--muted);
    border-radius:20px; padding:3px 10px 3px 4px; font-size:12px; white-space:nowrap;
  }
  .sw:hover { border-color:var(--accent); }
  .sw .dot { width:13px; height:13px; border-radius:50%; background:var(--dim); flex:none; }
  .sw.on { border-color:var(--good); color:var(--good); background:rgba(91,185,140,.1); }
  .sw.on .dot { background:var(--good); }
  .sw.busy { opacity:.5; pointer-events:none; }
  #gate { position:fixed; inset:0; background:var(--bg); display:flex; align-items:center; justify-content:center; }
  #gate .box { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:28px; width:min(400px,90vw); }
  #gate h2 { margin:0 0 6px; color:var(--text); font-size:17px; }
  #gate p { color:var(--muted); font-size:13px; margin:0 0 16px; }
  #gate input {
    width:100%; padding:9px 11px; margin-bottom:12px; border-radius:5px;
    border:1px solid var(--line); background:var(--panel2); color:var(--text);
    font-family:var(--mono); font-size:13px;
  }
  #gate button { width:100%; background:var(--accent); border-color:var(--accent); color:#0b1219; font-weight:600; padding:9px; }
  #gate .err { color:var(--bad); font-size:13px; min-height:18px; margin-top:8px; }
  .hide { display:none !important; }
</style>
</head>
<body>

<div id="gate">
  <div class="box">
    <h2>Auto Process Dashboard</h2>
    <p>Enter the access key to view operator activity.</p>
    <input id="keyInput" type="password" placeholder="Access key" autocomplete="off">
    <button id="keyGo">View dashboard</button>
    <div class="err" id="keyErr"></div>
  </div>
</div>

<div id="app" class="hide">
  <header>
    <h1>Auto Process &mdash; Operator Activity</h1>
    <span class="sub" id="stamp"></span>
    <span class="spacer"></span>
    <select id="operator"><option value="">All operators</option></select>
    <select id="range">
      <option value="1">Today</option>
      <option value="7" selected>Last 7 days</option>
      <option value="14">Last 14 days</option>
      <option value="30">Last 30 days</option>
      <option value="90">Last 90 days</option>
    </select>
    <button id="refresh">Refresh</button>
    <button id="csv">Download CSV</button>
    <button id="forget">Sign out</button>
  </header>

  <main>
    <div class="cards" id="cards"></div>

    <h2>Alarms handled per day</h2>
    <div class="panel"><div class="chart" id="chartAlarms"></div></div>

    <h2>Average time inside an alarm, per day</h2>
    <div class="panel"><div class="chart" id="chartAvg"></div></div>

    <h2>By operator</h2>
    <div class="panel">
      <input id="opSearch" class="search" type="search" placeholder="Filter this table by name...">
      <div id="opsPanel"></div>
    </div>

    <h2>Recent auto process toggles</h2>
    <div class="panel" id="togglePanel"></div>
  </main>
</div>

<script>
var KEY_STORE = 'immixDashKey';
var key = '';
try { key = localStorage.getItem(KEY_STORE) || ''; } catch (e) {}

function el(id) { return document.getElementById(id); }

function fmtDur(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '--';
  var s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + 'm ' + (r < 10 ? '0' : '') + r + 's';
  var h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}
function fmtMins(ms) {
  if (!ms) return '--';
  var m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function fmtWhen(ts) {
  if (!ts) return '--';
  var d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
         ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function stripRole(s) {
  return String(s || '').replace(/\\s*\\([^)]*\\)\\s*$/, '');
}
function waitClass(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms > 30000) return 'bad';
  if (ms > 20000) return 'warn';
  return 'good';
}

function showGate(msg) {
  el('app').classList.add('hide');
  el('gate').classList.remove('hide');
  el('keyErr').textContent = msg || '';
  el('keyInput').focus();
}

el('keyGo').onclick = function () {
  key = el('keyInput').value.trim();
  if (!key) { el('keyErr').textContent = 'Enter a key.'; return; }
  try { localStorage.setItem(KEY_STORE, key); } catch (e) {}
  load();
};
el('keyInput').onkeydown = function (e) { if (e.key === 'Enter') el('keyGo').onclick(); };
el('forget').onclick = function () {
  try { localStorage.removeItem(KEY_STORE); } catch (e) {}
  key = ''; el('keyInput').value = ''; showGate('');
};
el('refresh').onclick = function () { load(); };
el('range').onchange = function () { load(); };
el('operator').onchange = function () { load(); };
el('opSearch').oninput = function () { renderOps(null); };
el('csv').onclick = function () {
  fetch('/export?days=' + el('range').value, { headers: { 'X-Api-Key': key } })
    .then(function (r) { return r.text(); })
    .then(function (txt) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv' }));
      a.download = 'immix-events.csv';
      a.click();
    });
};

function load() {
  if (!key) { showGate(''); return; }
  el('stamp').textContent = 'loading...';

  var q = '/api/summary?days=' + el('range').value;
  if (el('operator').value) q += '&user=' + encodeURIComponent(el('operator').value);

  fetch(q, { headers: { 'X-Api-Key': key } })
    .then(function (r) {
      if (r.status === 401) { showGate('That key was not accepted.'); return null; }
      return r.json();
    })
    .then(function (d) {
      if (!d) return;
      if (d.error) { el('stamp').textContent = 'error: ' + d.error; return; }
      el('gate').classList.add('hide');
      el('app').classList.remove('hide');
      render(d);
    })
    .catch(function () { el('stamp').textContent = 'network error'; });
}

function fillRoster(roster) {
  var sel = el('operator');
  var want = sel.value;
  var html = '<option value="">All operators</option>';
  (roster || []).forEach(function (r) {
    html += '<option value="' + esc(r.user_id) + '">' + esc(stripRole(r.operator)) + '</option>';
  });
  sel.innerHTML = html;
  sel.value = want;                       // keep the current pick selected
  if (sel.value !== want) sel.value = ''; // that operator dropped out of range
}

function render(d) {
  var t = d.totals || {};
  applyPolicies(d.policies);
  fillRoster(d.roster);
  el('stamp').textContent = 'updated ' + new Date(d.generated_at).toLocaleTimeString();

  el('cards').innerHTML =
    card('Alarms handled', t.alarms || 0, (t.operators || 0) + ' operators reporting') +
    card('Avg time in alarm', fmtDur(t.avg_alarm_ms), 'opening to clearing') +
    card('Avg alarm sat', fmtDur(t.avg_queue_wait_ms), (t.manual_pickups || 0) + ' manual pickups') +
    card('Auto pickups', t.auto_pickups || 0,
         (t.times_turned_off || 0) + ' switched off, ' +
         (t.blocked_overrides || 0) + ' blocked');

  drawChart('chartAlarms', d.daily, 'alarms', function (v) { return v || 0; });
  drawChart('chartAvg', d.daily, 'avg_alarm_ms', fmtDur);

  renderOps(d.operators || []);
  renderToggles(d.toggles || []);
}

function card(label, value, note) {
  return '<div class="card"><div class="label">' + esc(label) +
         '</div><div class="value">' + esc(value) +
         '</div><div class="note">' + esc(note) + '</div></div>';
}

function dayLabel(row) {
  if (!row.day) return '';
  var p = String(row.day).split('-');
  return p[1] + '/' + p[2];
}

function drawChart(id, rows, field, fmt) {
  var host = el(id);
  if (!rows || !rows.length) { host.innerHTML = '<div class="empty">No data yet.</div>'; return; }

  var max = 0;
  rows.forEach(function (r) { if ((r[field] || 0) > max) max = r[field] || 0; });
  if (!max) max = 1;

  host.innerHTML = rows.map(function (r) {
    var v = r[field] || 0;
    var h = Math.max(2, Math.round((v / max) * 120));
    return '<div class="bar" title="' + esc(dayLabel(r)) + ': ' + esc(fmt(v)) + '">' +
             '<div class="cap">' + esc(fmt(v)) + '</div>' +
             '<div class="fill" style="height:' + h + 'px"></div>' +
             '<div class="lab">' + esc(dayLabel(r)) + '</div>' +
           '</div>';
  }).join('');
}

var OP_COLUMNS = [
  { key:'operator',          label:'Operator',        text:true },
  { key:'alarms',            label:'Alarms' },
  { key:'avg_alarm_ms',      label:'Avg in alarm',    fmt:fmtDur },
  { key:'auto_pickups',      label:'Auto' },
  { key:'manual_pickups',    label:'Manual' },
  { key:'avg_queue_wait_ms', label:'Avg alarm sat',   fmt:fmtDur, cls:waitClass },
  { key:'avg_wait_ms',       label:'Avg counter',     fmt:fmtDur },
  { key:'times_turned_off',  label:'Switched off' },
  { key:'blocked_overrides', label:'Blocked', cls:function(v){ return v > 0 ? 'warn' : ''; } },
  { key:'ms_auto_off',       label:'Time off',        fmt:fmtMins },
  { key:'last_seen',         label:'Last seen',       fmt:fmtWhen },
  { key:'force_on',          label:'Force on',        control:true }
];

var opsData = [];
var sortKey = 'alarms';
var sortDir = -1;

var policyMap = {};
var adminKey = '';
try { adminKey = localStorage.getItem('immixDashAdminKey') || ''; } catch (e) {}

function applyPolicies(list) {
  policyMap = {};
  (list || []).forEach(function (p) { policyMap[p.user_id] = !!p.force_on; });
}

function setForceOn(userId, want, node) {
  node.classList.add('busy');
  fetch('/api/policy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': adminKey || key },
    body: JSON.stringify({ user_id: userId, force_on: want })
  })
  .then(function (r) {
    if (r.status === 401) {
      var entered = prompt('An admin key is required to change this. Enter it:');
      if (entered) {
        adminKey = entered.trim();
        try { localStorage.setItem('immixDashAdminKey', adminKey); } catch (e) {}
        node.classList.remove('busy');
        setForceOn(userId, want, node);
      } else {
        node.classList.remove('busy');
      }
      return null;
    }
    return r.json();
  })
  .then(function (res) {
    if (!res) return;
    node.classList.remove('busy');
    if (res.error) { alert('Could not save: ' + res.error); return; }
    policyMap[userId] = !!res.force_on;
    opsData.forEach(function (o) {
      if (o.user_id === userId) o.force_on = !!res.force_on;
    });
    renderOps(null);
  })
  .catch(function () {
    node.classList.remove('busy');
    alert('Network error saving the override.');
  });
}

function renderOps(ops) {
  if (ops) {
    opsData = ops.map(function (o) {
      o.force_on = !!policyMap[o.user_id];
      return o;
    });
  }
  var host = el('opsPanel');

  if (!opsData.length) {
    host.innerHTML = '<div class="empty">No operators have reported yet.</div>';
    return;
  }

  var q = (el('opSearch').value || '').toLowerCase().trim();
  var rows = opsData.filter(function (o) {
    return !q || String(o.operator || '').toLowerCase().indexOf(q) !== -1;
  });

  rows = rows.slice().sort(function (a, b) {
    var col = null;
    OP_COLUMNS.forEach(function (c) { if (c.key === sortKey) col = c; });
    var x = a[sortKey], y = b[sortKey];
    if (col && col.text) {
      return String(x || '').localeCompare(String(y || '')) * sortDir;
    }
    x = (x === null || x === undefined) ? -1 : x;
    y = (y === null || y === undefined) ? -1 : y;
    return (x - y) * sortDir;
  });

  if (!rows.length) {
    host.innerHTML = '<div class="empty">No operator matches that name.</div>';
    return;
  }

  var head = '<tr>' + OP_COLUMNS.map(function (c, i) {
    var arrow = c.key === sortKey ? '<span class="arrow">' + (sortDir < 0 ? '\u25be' : '\u25b4') + '</span>' : '';
    return '<th class="sortable' + (i ? ' n' : '') + '" data-key="' + c.key + '">' +
           esc(c.label) + arrow + '</th>';
  }).join('') + '</tr>';

  var body = rows.map(function (o) {
    var cells = OP_COLUMNS.map(function (c, i) {
      if (i === 0) {
        return '<td><div class="who">' + esc(stripRole(o.operator)) + '</div>' +
               (o.role ? '<div class="role">' + esc(o.role) + '</div>' : '') + '</td>';
      }
      if (c.control) {
        var on = !!o.force_on;
        return '<td class="n"><span class="sw' + (on ? ' on' : '') +
               '" data-user="' + esc(o.user_id) + '" data-want="' + (on ? '0' : '1') + '">' +
               '<span class="dot"></span>' + (on ? 'Forced on' : 'Off') + '</span></td>';
      }
      var raw = o[c.key];
      var shown = c.fmt ? c.fmt(raw) : (raw === null || raw === undefined ? 0 : raw);
      var cls = c.cls ? (' ' + c.cls(raw)) : '';
      return '<td class="n' + cls + '">' + esc(shown) + '</td>';
    }).join('');
    return '<tr>' + cells + '</tr>';
  }).join('');

  host.innerHTML = '<table>' + head + body + '</table>';

  var ths = host.querySelectorAll('th.sortable');
  for (var i = 0; i < ths.length; i++) {
    ths[i].onclick = function () {
      var k = this.getAttribute('data-key');
      if (k === sortKey) { sortDir = -sortDir; }
      else { sortKey = k; sortDir = -1; }
      renderOps(null);
    };
  }

  var sws = host.querySelectorAll('.sw');
  for (var j = 0; j < sws.length; j++) {
    sws[j].onclick = function () {
      var want = this.getAttribute('data-want') === '1';
      setForceOn(this.getAttribute('data-user'), want, this);
    };
  }
}

function renderToggles(rows) {
  var host = el('togglePanel');
  if (!rows.length) { host.innerHTML = '<div class="empty">No toggles recorded yet.</div>'; return; }

  var head = '<tr><th>When</th><th>Operator</th><th>Switched</th>' +
             '<th class="n">Previous state lasted</th><th class="n">Queue</th></tr>';

  var body = rows.map(function (r) {
    var cls = r.state === 'on' ? 'on' : 'off';
    return '<tr>' +
      '<td>' + esc(fmtWhen(r.server_ts)) + '</td>' +
      '<td>' + esc(stripRole(r.operator)) + '</td>' +
      '<td><span class="pill ' + cls + '">' + esc(r.state) + '</span></td>' +
      '<td class="n">' + esc(fmtMins(r.duration_ms)) + '</td>' +
      '<td class="n">' + (r.queue_size === null ? '--' : r.queue_size) + '</td>' +
    '</tr>';
  }).join('');

  host.innerHTML = '<table>' + head + body + '</table>';
}

if (key) { load(); } else { showGate(''); }
setInterval(function () {
  if (key && !el('app').classList.contains('hide')) load();
}, 60000);
</script>
</body>
</html>`;
