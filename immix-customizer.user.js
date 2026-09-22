// ==UserScript==
// @name         Immix Alarm Monitor - Auto Process v_5
// @namespace    smartviewplus.autoprocess
// @version      2.2.0
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

    const SCRIPT_VERSION = '2.2.0';

    /* ------------------------------------------------------------------
       Settings
    ------------------------------------------------------------------ */
    const POLL_MS          = 150;   // queue check / timer refresh
    const COOLDOWN_MS      = 500;   // minimum gap between process attempts
    const FADE_MS          = 600;   // background cross-fade
    // Note: the pause after page load before auto process can fire (your
    // window to hit OFF) now matches the selected pickup speed below.

    const RED_AFTER_S      = 20;    // seconds before the page goes red
    const MAX_SESSION_MS   = 60 * 60 * 1000;  // ignore absurdly long sessions

    const ON_COLOR   = '#1b6fd3';   // toggle button, auto process on
    const OFF_COLOR  = '#4a4a4a';   // toggle button, auto process off
    const LOCK_COLOR = '#146b3a';   // toggle button, auto process required on

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
        fast:    { label: 'Fast',    ms: 500  },
        default: { label: 'Default', ms: 1100 },
        slow:    { label: 'Slow',    ms: 2300 }
    };
    const SPEED_ORDER  = ['default', 'fast', 'slow'];
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

    // Why auto process is locked on right now, or null if it is free.
    // A supervisor override outranks the schedule because it has no end time.
    function lockReason() {
        if (typeof forcedOn === 'function' && forcedOn()) {
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
       Telemetry

       Every measurement is written to a local queue first, then shipped to
       the collector in batches. If the collector is unreachable the queue
       survives page loads and browser restarts and goes out later, so a
       flaky connection loses nothing. The server dedupes on eventId, so a
       retry that actually did land the first time is harmless.
    ================================================================== */
    const TELEMETRY_ENABLED  = true;
    const TELEMETRY_ENDPOINT = 'https://immix-telemetry.jdale-e67.workers.dev/ingest';
    const TELEMETRY_KEY      = '7kR9mQ2xL8pT5nV4cW6hJ3fD1bS8yA9eG0uZ';

    const FLUSH_MS     = 20 * 1000;
    const HEARTBEAT_MS = 5 * 60 * 1000;
    const MAX_QUEUE    = 2000;   // events held locally before the oldest drop
    const MAX_BATCH    = 100;    // events per request

    const POLICY_MS  = 60 * 1000;   // how often to ask the server for an override
    const POLICY_KEY = 'immixAutoProcess:policy';

    const QUEUE_KEY  = 'immixAutoProcess:telemetryQueue';
    const DEVICE_KEY = 'immixAutoProcess:deviceId';
    const NAME_KEY   = 'immixAutoProcess:operatorName';

    const PAGE_NAME = /sitemonitor\.aspx/i.test(location.pathname)
        ? 'sitemonitor' : 'alarmmonitor';

    function randomId() {
        try {
            const c = window.crypto || W.crypto;
            if (c && c.randomUUID) return c.randomUUID();
        } catch (e) {}
        return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    }

    const SESSION_ID = randomId();

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
    // Confirmed against the AlarmMonitor page source.
    function operatorName() {
        const el  = document.getElementById('UserFullName');
        const raw = el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '';

        if (raw) {
            try { localStorage.setItem(NAME_KEY, raw); } catch (e) {}
            return raw;
        }

        // SiteMonitor popups and odd page states fall back to the last name seen.
        try { return localStorage.getItem(NAME_KEY) || null; } catch (e) { return null; }
    }

    // "Operator J. Dale (Dispatcher)" -> "Dispatcher"
    function operatorRole() {
        const name = operatorName();
        if (!name) return null;
        const m = /\(([^)]+)\)\s*$/.exec(name);
        return m ? m[1].trim() : null;
    }

    function readQueue() {
        try {
            const raw = localStorage.getItem(QUEUE_KEY);
            const q = raw ? JSON.parse(raw) : [];
            return Array.isArray(q) ? q : [];
        } catch (e) {
            return [];
        }
    }

    function writeQueue(q) {
        try {
            localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
        } catch (e) {
            // Storage full or blocked. Drop the oldest half and try once more.
            try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-Math.floor(MAX_QUEUE / 2)))); } catch (e2) {}
        }
    }

    function track(type, data) {
        if (!TELEMETRY_ENABLED) return;
        const q = readQueue();
        q.push({
            eventId:       randomId(),
            type:          type,
            userId:        uid(),
            userName:      operatorName(),
            userRole:      operatorRole(),
            deviceId:      deviceId(),
            sessionId:     SESSION_ID,
            clientTs:      Date.now(),
            tzOffsetMin:   new Date().getTimezoneOffset(),
            scriptVersion: SCRIPT_VERSION,
            page:          PAGE_NAME,
            data:          data || {}
        });
        while (q.length > MAX_QUEUE) q.shift();
        writeQueue(q);
    }

    function post(body, done) {
        if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
                method:  'POST',
                url:     TELEMETRY_ENDPOINT,
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': TELEMETRY_KEY },
                data:    body,
                timeout: 15000,
                onload:     function (r) { done(r.status >= 200 && r.status < 300); },
                onerror:    function () { done(false); },
                ontimeout:  function () { done(false); }
            });
            return;
        }
        // Fallback if the grant is missing. Subject to the page's CSP.
        try {
            fetch(TELEMETRY_ENDPOINT, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': TELEMETRY_KEY },
                body:    body,
                keepalive: true
            }).then(function (r) { done(r.ok); }, function () { done(false); });
        } catch (e) {
            done(false);
        }
    }

    let sending = false;

    function flush() {
        if (!TELEMETRY_ENABLED || sending) return;
        const q = readQueue();
        if (!q.length) return;

        const batch = q.slice(0, MAX_BATCH);
        sending = true;

        post(JSON.stringify({ events: batch }), function (ok) {
            sending = false;
            if (!ok) return;   // leave it queued, try again next flush
            const sent = {};
            batch.forEach(function (e) { sent[e.eventId] = true; });
            writeQueue(readQueue().filter(function (e) { return !sent[e.eventId]; }));
        });
    }

    /* ------------------------------------------------------------------
       Remote override

       A supervisor can force auto process on for one operator from the
       dashboard. The answer is cached so a dropped connection leaves the
       last known instruction in force rather than silently lifting it.
    ------------------------------------------------------------------ */
    function policyCache() {
        try {
            const raw = localStorage.getItem(POLICY_KEY + ':' + uid());
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function forcedOn() {
        const p = policyCache();
        return !!(p && p.forceOn);
    }

    function fetchPolicy() {
        if (!TELEMETRY_ENABLED) return;
        const who = uid();
        if (!who || who === 'anon') return;

        const url = TELEMETRY_ENDPOINT.replace(/\/ingest$/, '/policy') +
                    '?user=' + encodeURIComponent(who);

        const handle = function (ok, text) {
            if (!ok) return;   // keep whatever we had
            let data;
            try { data = JSON.parse(text); } catch (e) { return; }
            if (!data || typeof data.force_on !== 'boolean') return;

            const was = forcedOn();
            try {
                localStorage.setItem(POLICY_KEY + ':' + who, JSON.stringify({
                    forceOn:   data.force_on,
                    note:      data.note || null,
                    fetchedAt: Date.now()
                }));
            } catch (e) {}

            if (was !== data.force_on) {
                track('policy_change', { forceOn: data.force_on, note: data.note || null });
            }
        };

        if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
                method: 'GET', url: url,
                headers: { 'X-Api-Key': TELEMETRY_KEY },
                timeout: 15000,
                onload:    function (r) { handle(r.status >= 200 && r.status < 300, r.responseText); },
                onerror:   function () {},
                ontimeout: function () {}
            });
        } else {
            try {
                fetch(url, { headers: { 'X-Api-Key': TELEMETRY_KEY } })
                    .then(function (r) { return r.ok ? r.text() : null; })
                    .then(function (t) { if (t) handle(true, t); }, function () {});
            } catch (e) {}
        }
    }

    setInterval(fetchPolicy, POLICY_MS);
    fetchPolicy();

    setInterval(flush, FLUSH_MS);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flush();
    });
    flush();   // anything left over from the previous page load

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
        flush();
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

            const lock = lockReason();
            if (lock && enabled) {
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

            setEnabled(!enabled, 'user');
        });

        li.appendChild(button);
        stats.insertBefore(li, stats.firstChild);
        paintButton();
    }

    function paintButton() {
        if (!button) return;

        const lock = lockReason();

        if (lock && Date.now() < flashUntil) {
            button.textContent = lock.until ? ('Required on until ' + lock.until)
                                            : 'Required on';
            button.style.backgroundColor = LOCK_COLOR;
            button.title = 'Auto process is ' + lock.label + '.';
            button.style.cursor = 'not-allowed';
            return;
        }

        if (lock && enabled) {
            button.textContent = lock.kind === 'policy'
                ? 'Auto process: on (required)'
                : 'Auto process: on (scheduled)';
            button.style.backgroundColor = LOCK_COLOR;
            button.title = 'Auto process is ' + lock.label +
                (lock.until ? '. It can be switched off after ' + lock.until + '.' : '.');
            button.style.cursor = 'not-allowed';
            return;
        }

        button.textContent = enabled ? 'Auto process: on' : 'Auto process: off';
        button.style.backgroundColor = enabled ? ON_COLOR : OFF_COLOR;
        button.title = 'Automatically open the oldest alarm in the queue';
        button.style.cursor = 'pointer';
    }

    function setEnabled(value, source) {
        const now      = Date.now();
        const since    = read('stateSince', null);
        const prevMs   = since ? now - since : null;
        const wasAuto  = enabled;
        const lock     = lockReason();

        // Nothing may switch it off while a lock is in force.
        if (value === false && lock) return;
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
            const waited = (Date.now() - timerStart) / 1000;
            const hot = queueHasAlarm() && waited >= RED_AFTER_S;
            elLabel.textContent = 'Since last alarm';
            elTimer.textContent = formatDuration(Date.now() - timerStart);
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

    function busy() {
        if (W.redirectingToSiteMonitor === true) return true;
        if (W._currentlyRequestingHandleEvent === true) return true;
        if (W.eventHandleInProgress === true) return true;
        if (W.alarmMonitor && W.alarmMonitor.update === false) return true;

        const smw = W.alarmMonitor && W.alarmMonitor.siteMonitorWindow;
        if (smw && !smw.closed) return true;

        if (dialogOpen()) return true;
        if (connectionError()) return true;
        return false;
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
        if (busy() || !hasAlarm) return;
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

    setInterval(function () {
        track('heartbeat', {
            enabled:           enabled,
            lockedOn:          (lockReason() || {}).label || null,
            speed:             speed,
            queueSize:         queueSize(),
            sinceLastAlarmMs:  Date.now() - timerStart,
            stats:             getStats()
        });
    }, HEARTBEAT_MS);

    lockedWindow = lockReason();   // seed, so startup isn't logged as a change
    if (lockedWindow && !enabled) setEnabled(true, lockedWindow.kind);

    createButton();
    createPanel();
    hookProcessAlarm();
    setInterval(tick, POLL_MS);
})();
