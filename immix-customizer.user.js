// ==UserScript==
// @name         Immix Alarm Monitor - Auto Process v_5
// @namespace    smartviewplus.autoprocess
// @version      3.2.0
// @description  Auto-process toggle with selectable speed (default/fast/slow), idle timer that resets when the queue empties, per-operator alarm stats (auto-reset at midnight) for the Immix Alarm Monitor.
// @author       you
// @match        https://newapp.smartviewplus.com/AlarmMonitor.aspx*
// @match        https://newapp.smartviewplus.com/SiteMonitor.aspx*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      immix-telemetry.jdale-e67.workers.dev
// Auto-update is OFF until the file is hosted. Once it has a permanent URL,
// restore the two lines below (remove the leading "x-" from each) so every
// agent picks up future changes automatically:
// x-updateURL    https://YOUR-HOST/immix-autoprocess.user.js
// x-downloadURL  https://YOUR-HOST/immix-autoprocess.user.js
// ==/UserScript==

(function () {
    'use strict';

    /* ------------------------------------------------------------------
       Page bridge

       This script now uses @grant, which puts it in Tampermonkey's sandbox.
       `window` in here is a wrapper, not the page. Anything the Immix page
       itself defines (currentUserId, handleFirstAlarm, alarmMonitor, ...)
       has to be read through unsafeWindow.
    ------------------------------------------------------------------ */
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

    const SCRIPT_VERSION = '3.2.0';

    /* ------------------------------------------------------------------
       Settings
    ------------------------------------------------------------------ */
    const POLL_MS          = 150;   // queue check / timer refresh
    const COOLDOWN_MS      = 100;   // minimum gap between process attempts
    // Note: the effective gap between pickups is the selected speed below,
    // not this. After each pickup the sit-timer restarts, so a Fast pickup
    // cannot fire again for 500ms regardless of what COOLDOWN_MS says.

    // If auto process is on, alarms are waiting, and something is blocking
    // every attempt for this long, treat it as a stall: report which flag is
    // stuck and, when STALL_RECOVER is on, clear the recoverable ones.
    const STALL_AFTER_MS   = 15000;
    const STALL_RECOVER    = true;
    const FADE_MS          = 600;   // background cross-fade
    // Note: the pause after page load before auto process can fire (your
    // window to hit OFF) now matches the selected pickup speed below.

    const RED_AFTER_S      = 20;    // seconds before the page goes red
    const MAX_SESSION_MS   = 60 * 60 * 1000;  // ignore absurdly long sessions

    const ON_COLOR   = '#1b6fd3';   // toggle button, auto process on
    const OFF_COLOR  = '#4a4a4a';   // toggle button, auto process off
    const LOCK_COLOR = '#146b3a';   // toggle button, auto process required on
    const OFF_LOCK_COLOR = '#8a5a12';   // toggle button, auto process forced off by a supervisor

    // Windows where auto process must stay on. Local time on the operator's
    // machine, 24-hour "HH:MM". A window whose end is earlier than its start
    // runs through midnight. Edit or empty this list to change the policy.
    const MANDATORY_WINDOWS = [
        { from: '23:00', to: '04:00' },
        { from: '05:00', to: '09:30' }
    ];
    const PAGE_COLOR = '#0b3c78';   // page background, auto process on
    const RED_COLOR  = '#9b1119';   // page background, alarms sitting too long

    // How long an alarm sits in the queue before auto process opens it.
    const SPEEDS = {
        instant: { label: 'Instant', ms: 100  },
        fast:    { label: 'Fast',    ms: 500  },
        default: { label: 'Default', ms: 1100 },
        slow:    { label: 'Slow',    ms: 2300 }
    };
    const SPEED_ORDER  = ['default', 'fast', 'instant', 'slow'];
    const DEFAULT_SPEED = 'default';

    function normalizeSpeed(value) {
        return SPEEDS[value] ? value : DEFAULT_SPEED;
    }

    /* ------------------------------------------------------------------
       Mandatory-on schedule
    ------------------------------------------------------------------ */
    function hhmmToMinutes(hhmm) {
        const p = String(hhmm).split(':');
        return (parseInt(p[0], 10) * 60) + parseInt(p[1] || '0', 10);
    }

    // The window covering right now, or null. Windows that wrap past
    // midnight (23:00 to 04:00) are handled by the inverted comparison.
    function activeWindow(at) {
        const now = at || new Date();
        const mins = (now.getHours() * 60) + now.getMinutes();

        for (let i = 0; i < MANDATORY_WINDOWS.length; i++) {
            const w = MANDATORY_WINDOWS[i];
            const a = hhmmToMinutes(w.from);
            const b = hhmmToMinutes(w.to);
            const inside = (a < b) ? (mins >= a && mins < b)
                                   : (mins >= a || mins < b);
            if (inside) return w;
        }
        return null;
    }

    function windowLabel(w) {
        return w ? (w.from + ' to ' + w.to) : '';
    }

    // Why auto process is locked ON right now, or null if it is free to turn
    // off. A supervisor's "on" override outranks the schedule because it has
    // no end time. A supervisor's "off" override outranks everything here,
    // including a mandatory window - see forcedOff(), checked separately by
    // callers that need to know whether turning ON is blocked instead.
    function lockReason() {
        if (forcedOff()) return null;
        if (forcedOn()) {
            return { kind: 'policy', label: 'required by your supervisor', until: null };
        }
        const w = activeWindow();
        if (w) {
            return { kind: 'schedule', label: 'scheduled ' + windowLabel(w), until: w.to };
        }
        return null;
    }

    function lockKey(r) {
        return r ? (r.kind + ':' + r.label) : '';
    }

    /* ------------------------------------------------------------------
       Storage - everything except the operator pointer is keyed per user
    ------------------------------------------------------------------ */
    const LAST_USER_KEY = 'immixAutoProcessLastUser';

    function uid() {
        if (W.currentUserId) return String(W.currentUserId);
        try {
            const saved = localStorage.getItem(LAST_USER_KEY);
            if (saved) return saved;
        } catch (e) {}
        return 'anon';
    }

    function key(name) {
        return 'immixAutoProcess:' + uid() + ':' + name;
    }

    function read(name, fallback) {
        try {
            const raw = localStorage.getItem(key(name));
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function write(name, value) {
        try { localStorage.setItem(key(name), JSON.stringify(value)); } catch (e) {}
    }

    function getStats() {
        return read('stats', { count: 0, totalMs: 0 });
    }

    // Closes an open event session and folds it into the running totals.
    function closeOutPending() {
        const pending = read('pending', null);
        if (!pending || !pending.startedAt) return false;

        try { localStorage.removeItem(key('pending')); } catch (e) {}

        const elapsed = Date.now() - pending.startedAt;
        if (elapsed <= 0 || elapsed > MAX_SESSION_MS) {
            track('alarm_session_dropped', {
                alarmEventId: pending.eventId,
                startedAt:    pending.startedAt,
                durationMs:   elapsed
            });
            return false;
        }

        const stats = getStats();
        stats.count += 1;
        stats.totalMs += elapsed;
        write('stats', stats);

        track('alarm_session', {
            alarmEventId: pending.eventId,
            startedAt:    pending.startedAt,
            durationMs:   elapsed
        });
        return true;
    }

    function formatDuration(ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    /* ------------------------------------------------------------------
       Daily stats reset - processed count / average clear at local midnight
    ------------------------------------------------------------------ */
    function todayStamp() {
        const d = new Date();
        return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    }

    function checkDailyReset() {
        const today = todayStamp();
        const lastDay = read('statsDay', null);
        if (lastDay !== today) {
            write('stats', { count: 0, totalMs: 0 });
            write('statsDay', today);
        }
    }


    /* ==================================================================
       Reporting (lean mode)

       Nothing is sent per event. Each measurement adds to a small set of
       daily counters kept on this machine. Every CHECKIN_MS the Alarm
       Monitor page sends those counters in one request, and the reply
       carries the supervisor's force-on setting. That is one request and
       one database write per agent per interval, which keeps 64 agents
       comfortably inside Cloudflare's free plan.

       Counters live in localStorage, so page loads and navigating into an
       alarm and back do not reset them, and a missed check-in just means
       the next one carries the same totals.
    ================================================================== */
    const TELEMETRY_ENABLED = true;
    const TELEMETRY_BASE    = 'https://immix-telemetry.jdale-e67.workers.dev';
    const TELEMETRY_KEY     = '7kR9mQ2xL8pT5nV4cW6hJ3fD1bS8yA9eG0uZ';

    // How often each agent checks in. This is also how quickly a Force on
    // change from the dashboard reaches the agent. See the note in the
    // setup guide before lowering it: 32 agents at 45s is about 61,000
    // requests a day in the worst case, against a free limit of 100,000.
    const CHECKIN_MS      = 45 * 1000;
    const EARLY_GAP_MS    = 15 * 1000;   // a toggle may check in early, but no more often than this
    const MAX_OFF_STRETCH = 12 * 60 * 60 * 1000;

    const POLICY_KEY       = 'immixAutoProcess:policy';
    const LAST_CHECKIN_KEY = 'immixAutoProcess:lastCheckin';
    const DEVICE_KEY       = 'immixAutoProcess:deviceId';
    const NAME_KEY         = 'immixAutoProcess:operatorName';
    const OLD_QUEUE_KEY    = 'immixAutoProcess:telemetryQueue';

    // The event queue from earlier versions is no longer used.
    try { localStorage.removeItem(OLD_QUEUE_KEY); } catch (e) {}

    const PAGE_NAME = /sitemonitor\.aspx/i.test(location.pathname)
        ? 'sitemonitor' : 'alarmmonitor';

    function randomId() {
        try {
            const c = window.crypto || W.crypto;
            if (c && c.randomUUID) return c.randomUUID();
        } catch (e) {}
        return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    }

    function deviceId() {
        try {
            let id = localStorage.getItem(DEVICE_KEY);
            if (!id) {
                id = randomId();
                localStorage.setItem(DEVICE_KEY, id);
            }
            return id;
        } catch (e) {
            return 'no-storage';
        }
    }

    // The Immix header renders the signed-in operator as
    //   <a id="UserFullName">Operator J. Dale (Dispatcher)</a>
    function operatorName() {
        const el  = document.getElementById('UserFullName');
        const raw = el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '';

        if (raw) {
            try { localStorage.setItem(NAME_KEY, raw); } catch (e) {}
            return raw;
        }
        try { return localStorage.getItem(NAME_KEY) || null; } catch (e) { return null; }
    }

    // "Operator J. Dale (Dispatcher)" -> "Dispatcher"
    function operatorRole() {
        const name = operatorName();
        if (!name) return null;
        const m = /\(([^)]+)\)\s*$/.exec(name);
        return m ? m[1].trim() : null;
    }

    /* ------------------------------------------------------------------
       Daily counters
    ------------------------------------------------------------------ */
    function localDay() {
        const d = new Date();
        const pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function blankDaily(day) {
        return {
            day: day,
            alarms: 0, alarmMs: 0,
            auto: 0, manual: 0,
            satMs: 0, satN: 0,
            off: 0, offMs: 0,
            blocked: 0, stalls: 0,
            lastStall: null, lastStallAt: null
        };
    }

    function readDaily() {
        const today = localDay();
        const d = read('daily', null);
        return (d && d.day === today) ? d : blankDaily(today);
    }

    // Kept under its old name so every existing measurement point still works.
    function track(type, data) {
        if (!TELEMETRY_ENABLED) return;
        data = data || {};
        const d = readDaily();

        switch (type) {
            case 'alarm_session':
                d.alarms += 1;
                d.alarmMs += Math.max(0, data.durationMs || 0);
                break;
            case 'pickup':
                if (data.mode === 'manual') {
                    d.manual += 1;
                    if (typeof data.queueWaitMs === 'number' && data.queueWaitMs >= 0) {
                        d.satMs += data.queueWaitMs;
                        d.satN  += 1;
                    }
                } else {
                    d.auto += 1;
                }
                break;
            case 'toggle':
                if (data.state === 'off') d.off += 1;
                if (data.state === 'on' && data.prevState === 'off' &&
                    typeof data.prevStateMs === 'number' && data.prevStateMs < MAX_OFF_STRETCH) {
                    d.offMs += data.prevStateMs;
                }
                break;
            case 'override_blocked':
                d.blocked += 1;
                break;
            case 'stall':
                d.stalls += 1;
                d.lastStall = data.reasons || null;
                d.lastStallAt = Date.now();
                break;
            default:
                return;   // everything else is not counted in lean mode
        }
        write('daily', d);
    }

    /* ------------------------------------------------------------------
       Supervisor override, cached so a dropped connection or a server
       error leaves the last known instruction in force.
    ------------------------------------------------------------------ */
    function policyCache() {
        try {
            const raw = localStorage.getItem(POLICY_KEY + ':' + uid());
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    // 'on', 'off', or null (no override). Reads what applyPolicyReply cached,
    // so it works the same whether the last successful check-in came back
    // just now or the connection has been down since.
    function forcedMode() {
        const p = policyCache();
        return (p && (p.mode === 'on' || p.mode === 'off')) ? p.mode : null;
    }

    function forcedOn()  { return forcedMode() === 'on'; }
    function forcedOff() { return forcedMode() === 'off'; }

    /* ------------------------------------------------------------------
       Check-in
    ------------------------------------------------------------------ */
    function lastCheckin() {
        try { return parseInt(localStorage.getItem(LAST_CHECKIN_KEY) || '0', 10) || 0; }
        catch (e) { return 0; }
    }

    function markCheckin(ts) {
        try { localStorage.setItem(LAST_CHECKIN_KEY, String(ts)); } catch (e) {}
    }

    function checkinBody() {
        const d = readDaily();
        const since = read('stateSince', null);
        const now = Date.now();

        // Include the off stretch still running, so a long one shows up
        // before the operator switches back on.
        let offMs = d.offMs;
        if (!enabled && since && now - since < MAX_OFF_STRETCH) offMs += now - since;

        const lock = lockReason();
        return JSON.stringify({
            userId:        uid(),
            userName:      operatorName(),
            userRole:      operatorRole(),
            deviceId:      deviceId(),
            scriptVersion: SCRIPT_VERSION,
            day:           d.day,
            tzOffsetMin:   new Date().getTimezoneOffset(),
            enabled:       enabled,
            speed:         speed,
            lockKind:      lock ? lock.kind : null,
            alarms:        d.alarms,
            alarmMs:       d.alarmMs,
            auto:          d.auto,
            manual:        d.manual,
            satMs:         d.satMs,
            satN:          d.satN,
            off:           d.off,
            offMs:         offMs,
            blocked:       d.blocked,
            stalls:        d.stalls,
            lastStall:     d.lastStall,
            lastStallAt:   d.lastStallAt
        });
    }

    function applyPolicyReply(text) {
        let data;
        try { data = JSON.parse(text); } catch (e) { return; }
        if (!data) return;

        let mode = null;
        if (data.mode === 'on' || data.mode === 'off') mode = data.mode;
        else if (typeof data.force_on === 'boolean') mode = data.force_on ? 'on' : null;
        else return;   // reply didn't carry a usable answer; keep the cached one

        try {
            localStorage.setItem(POLICY_KEY + ':' + uid(), JSON.stringify({
                mode:      mode,
                note:      data.note || null,
                fetchedAt: Date.now()
            }));
        } catch (e) {}
    }

    function checkin() {
        if (!TELEMETRY_ENABLED) return;
        const who = uid();
        if (!who || who === 'anon') return;

        // Claim the slot before sending, so a second tab or a reload in
        // the next few seconds does not send a duplicate.
        markCheckin(Date.now());

        const url  = TELEMETRY_BASE + '/checkin';
        const body = checkinBody();
        const headers = { 'Content-Type': 'application/json', 'X-Api-Key': TELEMETRY_KEY };

        if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
                method: 'POST', url: url, headers: headers, data: body, timeout: 15000,
                onload: function (r) {
                    // Only a 200 carries a trustworthy policy. Anything else,
                    // including the free-tier limit being reached, keeps the cache.
                    if (r.status >= 200 && r.status < 300) applyPolicyReply(r.responseText);
                },
                onerror: function () {}, ontimeout: function () {}
            });
            return;
        }
        try {
            fetch(url, { method: 'POST', headers: headers, body: body })
                .then(function (r) { return r.ok ? r.text() : null; })
                .then(function (t) { if (t) applyPolicyReply(t); }, function () {});
        } catch (e) {}
    }

    // Called on the scheduler tick; sends only when an interval has passed.
    function checkinIfDue() {
        if (Date.now() - lastCheckin() >= CHECKIN_MS) checkin();
    }

    // Kept under its old name. A toggle or a blocked attempt reports early
    // so the dashboard catches up quickly, but never more than once per
    // EARLY_GAP_MS.
    function flush() {
        if (Date.now() - lastCheckin() >= EARLY_GAP_MS) checkin();
    }

    /* ==================================================================
       SiteMonitor - stamp the start of an event, then get out of the way
    ================================================================== */
    if (/sitemonitor\.aspx/i.test(location.pathname)) {
        const eventId = new URLSearchParams(location.search).get('EventId') || 'unknown';
        const pending = read('pending', null);

        if (!pending || pending.eventId !== eventId) {
            // A different event was left open; bank it before starting this one.
            if (pending) closeOutPending();
            write('pending', { eventId: eventId, startedAt: Date.now() });
            track('alarm_open', { alarmEventId: eventId });
        }
        return;
    }

    /* ==================================================================
       AlarmMonitor
    ================================================================== */

    // Remember who is signed in so SiteMonitor can use the same keys.
    if (W.currentUserId) {
        try { localStorage.setItem(LAST_USER_KEY, String(W.currentUserId)); } catch (e) {}
    }

    checkDailyReset();

    let enabled      = read('enabled', false) === true;
    let speed        = normalizeSpeed(read('speed', DEFAULT_SPEED));
    let lastAction   = 0;
    let currentTint  = null;
    let alarmSeenAt  = null;   // when the current queue first showed an alarm
    let blockedSince = null;   // when the current blocked-with-alarms run began
    let lastStallAt  = 0;      // last time a stall was reported
    let lockedWindow = null;   // the mandatory window in force, or null
    let flashUntil   = 0;      // show the "locked" message on the button until this time
    let prevHasAlarm = null;   // queue state on the previous tick, for empty-transition detection
    const loadedAt   = Date.now();
    let button       = null;
    let panel        = null;
    let elLabel      = null;
    let elTimer      = null;
    let elCount      = null;
    let elAvg        = null;
    let elSpeed      = null;

    function pickupDelayMs() {
        return SPEEDS[speed].ms;
    }

    // The clock restarts on page load (which is how you arrive back here
    // after clearing an event), on a Process Alarm click, when auto
    // process is switched back off, and whenever the queue drains to zero.
    let timerStart = Date.now();
    write('timerStart', timerStart);

    function restartTimer() {
        timerStart = Date.now();
        write('timerStart', timerStart);
    }

    // Returning here means the event that was open is finished.
    closeOutPending();

    /* ------------------------------------------------------------------
       Toggle button
    ------------------------------------------------------------------ */
    function createButton() {
        const stats = document.querySelector('ul.stats');
        if (!stats || document.getElementById('autoProcessToggle')) return;

        const li = document.createElement('li');
        li.style.cssText = 'float:none;display:inline-block;margin:0 18px 0 0;padding:0;';

        button = document.createElement('a');
        button.id = 'autoProcessToggle';
        button.href = 'javascript:void(0);';
        button.title = 'Automatically open the oldest alarm in the queue';
        button.style.cssText = [
            'display:inline-block', 'padding:4px 12px', 'border-radius:3px',
            'border:1px solid rgba(255,255,255,0.25)', 'color:#fff',
            'font-weight:bold', 'font-size:12px', 'line-height:18px',
            'text-decoration:none', 'cursor:pointer', 'white-space:nowrap'
        ].join(';');

        button.addEventListener('click', function (e) {
            e.preventDefault();

            const wantsOn = !enabled;

            if (wantsOn && forcedOff()) {
                // A supervisor turned this off. Say so rather than failing silently.
                flashUntil = Date.now() + 3000;
                paintButton();
                track('override_blocked', { lockKind: 'policy-off', window: null, queueSize: queueSize() });
                flush();
                return;
            }

            const lock = lockReason();
            if (!wantsOn && lock) {
                // Required on right now. Say so rather than failing silently.
                flashUntil = Date.now() + 3000;
                paintButton();
                track('override_blocked', {
                    lockKind:  lock.kind,
                    window:    lock.until ? lock.label : null,
                    queueSize: queueSize()
                });
                flush();
                return;
            }

            setEnabled(wantsOn, 'user');
        });

        li.appendChild(button);
        stats.insertBefore(li, stats.firstChild);
        paintButton();
    }

    // Works out what the button should say, then writes it only if it
    // differs. Called every tick, so a change in *why* auto process is
    // locked (a window opening, a supervisor override arriving) and the end
    // of the "Required on" flash both show up straight away.
    function paintButton() {
        if (!button) return;

        const lock = lockReason();
        const off  = forcedOff();
        let text, color, title, cursor;

        if (off && Date.now() < flashUntil) {
            text   = 'Off \u2014 supervisor';
            color  = OFF_LOCK_COLOR;
            title  = 'Auto process was turned off by a supervisor.';
            cursor = 'not-allowed';
        } else if (off) {
            text   = 'Auto process: off (supervisor)';
            color  = OFF_LOCK_COLOR;
            title  = 'A supervisor turned this off. It stays off until they turn it back on.';
            cursor = 'not-allowed';
        } else if (lock && Date.now() < flashUntil) {
            text   = lock.until ? ('Required on until ' + lock.until) : 'Required on';
            color  = LOCK_COLOR;
            title  = 'Auto process is ' + lock.label + '.';
            cursor = 'not-allowed';
        } else if (lock && enabled) {
            text   = lock.kind === 'policy' ? 'Auto process: on (required)'
                                            : 'Auto process: on (scheduled)';
            color  = LOCK_COLOR;
            title  = 'Auto process is ' + lock.label +
                     (lock.until ? '. It can be switched off after ' + lock.until + '.' : '.');
            cursor = 'not-allowed';
        } else {
            text   = enabled ? 'Auto process: on' : 'Auto process: off';
            color  = enabled ? ON_COLOR : OFF_COLOR;
            title  = 'Automatically open the oldest alarm in the queue';
            cursor = 'pointer';
        }

        if (button.textContent !== text) button.textContent = text;
        if (button.dataset.apColor !== color) {
            button.style.backgroundColor = color;
            button.dataset.apColor = color;
        }
        if (button.title !== title) button.title = title;
        if (button.style.cursor !== cursor) button.style.cursor = cursor;
    }

    function setEnabled(value, source) {
        const now      = Date.now();
        const since    = read('stateSince', null);
        const prevMs   = since ? now - since : null;
        const wasAuto  = enabled;
        const lock     = lockReason();

        // Nothing may switch it off while a lock is in force, and nothing
        // may switch it on while a supervisor has forced it off.
        if (value === false && lock) return;
        if (value === true && forcedOff()) return;
        if (value === enabled) return;

        enabled = value;
        write('enabled', enabled);
        write('stateSince', now);

        if (enabled) {
            lastAction = now;
        } else {
            restartTimer();   // clock picks up from the moment you take over
        }
        paintButton();
        paintPanel();
        applyTint(tintForNow());

        track('toggle', {
            state:      enabled ? 'on' : 'off',
            prevState:  wasAuto ? 'on' : 'off',
            prevStateMs: prevMs,      // how long the previous state lasted
            source:     source || 'user',   // user | schedule | policy
            lockKind:   lock ? lock.kind : null,
            window:     lock && lock.until ? lock.label : null,
            speed:      speed,
            queueSize:  queueSize()
        });
        flush();   // toggles are the interesting ones, send them straight away
    }

    function setSpeed(value) {
        const from = speed;
        speed = normalizeSpeed(value);
        write('speed', speed);
        alarmSeenAt = null;   // re-measure the current alarm against the new delay
        paintPanel();
        if (from !== speed) track('speed_change', { from: from, to: speed });
    }

    /* ------------------------------------------------------------------
       Stats panel, sits directly under the Process Alarm button
    ------------------------------------------------------------------ */
    function createPanel() {
        const host = document.querySelector('.side-buttons');
        if (!host || document.getElementById('autoProcessPanel')) return;

        panel = document.createElement('div');
        panel.id = 'autoProcessPanel';
        panel.style.cssText = [
            'clear:both', 'margin-top:10px', 'padding:10px 8px',
            'background:#1c1c1c', 'border:1px solid #4a4a4a', 'border-radius:3px',
            'color:#ddd', 'font-size:11px', 'line-height:1.5',
            'text-align:center', 'box-sizing:border-box'
        ].join(';');

        const speedOptions = SPEED_ORDER.map(function (id) {
            return '<option value="' + id + '">' +
                   SPEEDS[id].label + ' (' + (SPEEDS[id].ms / 1000) + 's)' +
                   '</option>';
        }).join('');

        panel.innerHTML =
            '<div id="apLabel" style="font-size:10px;color:#999;">Since last alarm</div>' +
            '<div id="apTimer" style="font-size:26px;font-weight:bold;color:#fff;' +
            'transition:color ' + FADE_MS + 'ms ease;">0:00</div>' +
            '<div style="margin-top:8px;border-top:1px solid #3a3a3a;padding-top:6px;">' +
            '  <div>Processed <span id="apCount" style="color:#fff;font-weight:bold;">0</span></div>' +
            '  <div>Average <span id="apAvg" style="color:#fff;font-weight:bold;">--</span></div>' +
            '</div>' +
            '<div style="margin-top:8px;border-top:1px solid #3a3a3a;padding-top:6px;">' +
            '  <div style="font-size:10px;color:#999;margin-bottom:3px;">Pickup speed</div>' +
            '  <select id="apSpeed" style="width:100%;background:#2a2a2a;color:#fff;' +
            '    border:1px solid #4a4a4a;border-radius:3px;font-size:11px;padding:3px 4px;' +
            '    cursor:pointer;box-sizing:border-box;">' + speedOptions + '</select>' +
            '</div>' +
            '<a href="javascript:void(0);" id="apReset" ' +
            'style="display:inline-block;margin-top:8px;font-size:10px;color:#7ea6d8;' +
            'text-decoration:none;">Reset totals</a>';

        host.appendChild(panel);

        elLabel = panel.querySelector('#apLabel');
        elTimer = panel.querySelector('#apTimer');
        elCount = panel.querySelector('#apCount');
        elAvg   = panel.querySelector('#apAvg');
        elSpeed = panel.querySelector('#apSpeed');

        elSpeed.value = speed;
        elSpeed.addEventListener('change', function () {
            setSpeed(elSpeed.value);
        });

        panel.querySelector('#apReset').addEventListener('click', function () {
            if (confirm('Reset your processed count and average?')) {
                const before = getStats();
                write('stats', { count: 0, totalMs: 0 });
                paintPanel();
                track('stats_reset', { count: before.count, totalMs: before.totalMs });
            }
        });

        paintPanel();
    }

    function paintPanel() {
        if (!panel) return;

        const lock = lockReason();

        if (enabled && lock) {
            elLabel.textContent = lock.until ? ('Required on until ' + lock.until)
                                             : 'Required on';
            elTimer.textContent = '--';
            elTimer.style.color = '#7fd1a0';
        } else if (enabled) {
            elLabel.textContent = 'Timer paused';
            elTimer.textContent = '--';
            elTimer.style.color = '#777';
        } else {
            const hasAlarm = queueHasAlarm();
            const waitedMs = hasAlarm ? (Date.now() - timerStart) : 0;
            const hot = hasAlarm && (waitedMs / 1000) >= RED_AFTER_S;
            elLabel.textContent = 'Since last alarm';
            elTimer.textContent = formatDuration(waitedMs);
            elTimer.style.color = hot ? '#ff6b6b' : '#fff';
        }

        if (elSpeed && elSpeed.value !== speed) elSpeed.value = speed;

        const stats = getStats();
        elCount.textContent = stats.count;
        elAvg.textContent = stats.count ? formatDuration(stats.totalMs / stats.count) : '--';
    }

    /* ------------------------------------------------------------------
       Process Alarm click - restarts the timer
    ------------------------------------------------------------------ */
    function hookProcessAlarm() {
        const btn = document.querySelector('a.btn-processalarm');
        if (!btn || btn.dataset.apHooked) return;
        btn.dataset.apHooked = '1';

        btn.addEventListener('click', function (e) {
            if (!e.isTrusted) return;   // ignore clicks the script makes
            track('pickup', {
                mode:      'manual',
                waitMs:    Date.now() - timerStart,   // the counter on the panel
                // How long this alarm actually sat in the queue. Cleaner than
                // waitMs, which also counts idle time before the alarm arrived.
                queueWaitMs: alarmSeenAt ? (Date.now() - alarmSeenAt) : null,
                queueSize: queueSize(),
                autoState: enabled ? 'on' : 'off'
            });
            restartTimer();
            paintPanel();
            applyTint(tintForNow());
        }, true);
    }

    /* ------------------------------------------------------------------
       Background tint
    ------------------------------------------------------------------ */
    function applyTint(color) {
        if (color === currentTint) return;
        currentTint = color;

        let style = document.getElementById('autoProcessPageTint');

        if (!color) {
            if (style) style.remove();
            return;
        }

        if (!style) {
            style = document.createElement('style');
            style.id = 'autoProcessPageTint';
            document.head.appendChild(style);
        }

        style.textContent =
            'html, body, body.admin, .main {' +
            '  background-color: ' + color + ' !important;' +
            '  transition: background-color ' + FADE_MS + 'ms ease;' +
            '}';
    }

    function tintForNow() {
        if (enabled) return PAGE_COLOR;
        if (!queueHasAlarm()) return null;
        return (Date.now() - timerStart) / 1000 >= RED_AFTER_S ? RED_COLOR : null;
    }

    /* ------------------------------------------------------------------
       Queue inspection
    ------------------------------------------------------------------ */
    function queueHasAlarm() {
        const body = document.getElementById('alarmTable');
        return !!body && body.querySelectorAll('tr').length > 0;
    }

    function queueSize() {
        const body = document.getElementById('alarmTable');
        return body ? body.querySelectorAll('tr').length : 0;
    }

    function dialogOpen() {
        return Array.prototype.some.call(
            document.querySelectorAll('.ui-dialog'),
            function (d) { return d.offsetParent !== null; }
        );
    }

    function connectionError() {
        const el = document.getElementById('divConnectionErrorHolder');
        return !!el && !el.classList.contains('hide');
    }

    // Everything currently stopping a pickup, by name. Knowing *which* guard
    // is set is what makes a stall diagnosable rather than a mystery.
    function blockingReasons() {
        const r = [];
        if (W.redirectingToSiteMonitor === true)        r.push('redirectingToSiteMonitor');
        if (W._currentlyRequestingHandleEvent === true) r.push('currentlyRequestingHandleEvent');
        if (W.eventHandleInProgress === true)           r.push('eventHandleInProgress');
        if (W.alarmMonitor && W.alarmMonitor.update === false) r.push('alarmMonitorUpdate');

        const smw = W.alarmMonitor && W.alarmMonitor.siteMonitorWindow;
        if (smw && !smw.closed) r.push('siteMonitorWindow');

        if (dialogOpen())      r.push('dialogOpen');
        if (connectionError()) r.push('connectionError');
        return r;
    }

    function busy() {
        return blockingReasons().length > 0;
    }

    /**
     * Clear the guards that can latch on after a failed request. Deliberately
     * conservative: an open dialog or a live site monitor window is a real
     * reason to wait, so those are reported but never touched. A
     * siteMonitorWindow reference is only dropped once the window has
     * genuinely closed.
     */
    function clearStuckFlags() {
        const cleared = [];
        try {
            if (W.redirectingToSiteMonitor === true) {
                W.redirectingToSiteMonitor = false; cleared.push('redirectingToSiteMonitor');
            }
            if (W._currentlyRequestingHandleEvent === true) {
                W._currentlyRequestingHandleEvent = false; cleared.push('currentlyRequestingHandleEvent');
            }
            if (W.eventHandleInProgress === true) {
                W.eventHandleInProgress = false; cleared.push('eventHandleInProgress');
            }
            if (W.alarmMonitor && W.alarmMonitor.update === false) {
                W.alarmMonitor.update = true; cleared.push('alarmMonitorUpdate');
            }
            const smw = W.alarmMonitor && W.alarmMonitor.siteMonitorWindow;
            if (smw && smw.closed) {
                W.alarmMonitor.siteMonitorWindow = null; cleared.push('siteMonitorWindow');
            }
        } catch (e) {}
        return cleared;
    }

    /* ------------------------------------------------------------------
       Main loop
    ------------------------------------------------------------------ */
    // Switches auto process on when a mandatory window opens and records the
    // window boundaries. Runs every tick, so a machine left open overnight
    // picks up each window as it arrives.
    function enforceSchedule() {
        const lock = lockReason();

        if (lockKey(lock) !== lockKey(lockedWindow)) {
            track('schedule_lock', {
                state:      lock ? 'engaged' : 'released',
                lockKind:   (lock || lockedWindow || {}).kind || null,
                window:     (lock || lockedWindow || {}).label || null,
                wasEnabled: enabled
            });
            lockedWindow = lock;
            flush();
        }

        if (lock && !enabled) setEnabled(true, lock.kind);
        if (forcedOff() && enabled) setEnabled(false, 'policy-off');
    }

    function tick() {
        checkDailyReset();
        enforceSchedule();

        if (!button) createButton();
        if (!panel) createPanel();
        hookProcessAlarm();

        const now = Date.now();
        const hasAlarm = queueHasAlarm();

        // Queue just drained to zero - reset the "since last alarm" clock.
        if (prevHasAlarm === true && hasAlarm === false) {
            restartTimer();
        }
        prevHasAlarm = hasAlarm;

        paintButton();
        paintPanel();
        applyTint(tintForNow());

        // Track how long the queue has had something in it.
        if (hasAlarm) {
            if (alarmSeenAt === null) alarmSeenAt = now;
        } else {
            alarmSeenAt = null;
        }

        if (!enabled) return;

        if (now - loadedAt < pickupDelayMs()) return;   // startup pause follows the speed setting
        if (now - lastAction < COOLDOWN_MS) return;
        if (typeof W.handleFirstAlarm !== 'function') return;

        // Watchdog. If alarms are waiting but something keeps blocking every
        // attempt, the script would otherwise sit quiet indefinitely.
        const reasons = hasAlarm ? blockingReasons() : [];

        if (reasons.length) {
            if (blockedSince === null) blockedSince = now;
            const stuckMs = now - blockedSince;

            if (stuckMs >= STALL_AFTER_MS && now - lastStallAt >= STALL_AFTER_MS) {
                lastStallAt = now;
                const cleared = STALL_RECOVER ? clearStuckFlags() : [];
                console.warn('[Auto process] stalled ' + Math.round(stuckMs / 1000) +
                             's, blocked by: ' + reasons.join(', ') +
                             (cleared.length ? ' | cleared: ' + cleared.join(', ') : ''));
                track('stall', {
                    blockedMs:  stuckMs,
                    reasons:    reasons.join(','),
                    cleared:    cleared.join(','),
                    recovered:  cleared.length > 0,
                    queueSize:  queueSize(),
                    speed:      speed
                });
                flush();
            }
            return;
        }

        blockedSince = null;

        if (!hasAlarm) return;
        if (now - alarmSeenAt < pickupDelayMs()) return;   // let it sit the chosen delay

        track('pickup', {
            mode:         'auto',
            waitMs:       now - timerStart,     // same clock the panel shows
            queueWaitMs:  now - alarmSeenAt,    // how long the alarm sat in the queue
            queueSize:    queueSize(),
            speed:        speed,
            autoState:    'on'
        });

        lastAction = now;
        alarmSeenAt = null;
        try {
            W.handleFirstAlarm();
        } catch (err) {
            console.error('[Auto process] handleFirstAlarm failed:', err);
        }
    }

    // First page load of the day (or the first since an upgrade) needs a
    // starting point for the on/off interval maths.
    if (read('stateSince', null) === null) write('stateSince', Date.now());

    track('page_load', {
        enabled:     enabled,
        lockedOn:    (lockReason() || {}).label || null,
        speed:       speed,
        queueSize: queueSize(),
        stats:     getStats(),
        userAgent: navigator.userAgent
    });


    lockedWindow = lockReason();   // seed, so startup isn't logged as a change
    if (lockedWindow && !enabled) setEnabled(true, lockedWindow.kind);
    if (forcedOff() && enabled) setEnabled(false, 'policy-off');

    createButton();
    createPanel();
    hookProcessAlarm();
    setInterval(tick, POLL_MS);

    // Check in once the page state exists, then on the schedule. The five
    // second tick only reads a timestamp; the interval itself is CHECKIN_MS.
    checkinIfDue();
    setInterval(checkinIfDue, 5000);
})();
