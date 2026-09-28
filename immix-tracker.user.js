// ==UserScript==
// @name         Immix Activity Tracker
// @namespace    immix-tracker
// @version      1.0.2
// @description  Records alarm activity and time on the Alarm Monitor page for a browser that does NOT run auto process. Never picks up an alarm. Stands down automatically if the auto process script is running in the same browser.
// @author       -
// @match        *://newapp.smartviewplus.com/AlarmMonitor.aspx*
// @match        *://newapp.smartviewplus.com/SiteMonitor.aspx*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      immix-telemetry.soc-autoprocess.workers.dev
// @connect      immix-telemetry.jdale-e67.workers.dev
// @updateURL    https://raw.githubusercontent.com/socscripts/soc-scripts/main/immix-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/socscripts/soc-scripts/main/immix-tracker.user.js
// ==/UserScript==

/*
 *  What this is
 *  ------------
 *  Agents work Immix in two browsers, but auto process is installed in only
 *  one of them. Everything done in the other browser was invisible to the
 *  reports. This script watches that second browser and reports the same
 *  activity, so an agent's totals cover all the work they actually did.
 *
 *  It contains no pickup code of any kind. There is no toggle, no timer and
 *  no call into Immix's own alarm handling, so it cannot turn auto process
 *  on, cannot race the other browser for an alarm, and cannot be switched
 *  into doing so by a setting.
 *
 *  It reports every 3 minutes rather than every 45 seconds. Nothing waits on
 *  it: it receives no instructions from the dashboard and answers no
 *  supervisor button, so the only thing a slower interval costs is how
 *  quickly the dashboard notices the browser has gone.
 *
 *  Requests go out through GM_xmlhttpRequest, not the page's own fetch, for
 *  the same reason the auto process script does it: the Immix page's content
 *  security policy blocks a request the page itself makes to another host, and
 *  it does so silently. This is why 1.0.0 counted correctly and reported
 *  nothing.
 *
 *  Rows are keyed by browser as well as by agent, so this never overwrites
 *  what the auto process browser reported. The reports add up what each
 *  browser handled and take the LONGER of the two times on page, never the
 *  sum, because one person with two browsers open for an hour has still
 *  worked one hour.
 */

(function () {
    'use strict';

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

    const SCRIPT_VERSION = '1.0.2';

    /* ------------------------------------------------------------------
       Settings
    ------------------------------------------------------------------ */
    // The first address is the one in use; the second is kept so this script
    // keeps working either side of a subdomain change, because the old
    // workers.dev address stops answering the moment the account subdomain is
    // renamed. Whichever answers is remembered, so the fallback costs an
    // extra request only when the first one is unreachable.
    const TELEMETRY_BASES = [
        'https://immix-telemetry.soc-autoprocess.workers.dev',
        'https://immix-telemetry.jdale-e67.workers.dev'
    ];
    const BASE_KEY = 'immixTracker:telemetryBase';
    const TELEMETRY_KEY  = '7kR9mQ2xL8pT5nV4cW6hJ3fD1bS8yA9eG0uZ';

    // How often this browser reports. The dashboard treats a tracker as gone
    // after 8 minutes of silence, so anything under about 4 minutes is safe.
    const CHECKIN_MS = 3 * 60 * 1000;

    const POLL_MS = 1000;            // how often the page is looked at
    const MAX_SESSION_MS = 60 * 60 * 1000;   // ignore absurdly long alarm sessions
    const MAX_TICK_GAP_MS = 5000;    // a gap longer than this is a sleeping machine, not time worked

    // If the auto process script is alive in this browser, this script does
    // nothing at all: no counting, no requests. That way installing it
    // everywhere is harmless, and only the browsers that need it report.
    const AP_ALIVE_MS = 10 * 60 * 1000;

    /* ------------------------------------------------------------------
       Storage. Separate keys from the auto process script, so the two can
       sit in one browser without touching each other's numbers.
    ------------------------------------------------------------------ */
    const NS = 'immixTracker:';
    const DEVICE_KEY   = NS + 'deviceId';
    const DAILY_KEY    = NS + 'daily';
    const HOURS_KEY    = NS + 'hours';
    const PENDING_KEY  = NS + 'pending';
    const QUEUE_KEY    = NS + 'lastQueueSize';
    const CHECKIN_KEY  = NS + 'nextCheckin';
    const LAST_USER_KEY = NS + 'lastUser';

    // Written by the auto process script. Read only, and only to find out
    // whether it is running here.
    const AP_TOGGLE_ID = 'autoProcessToggle';
    const AP_CHECKIN_KEY = 'immixAutoProcess:lastCheckin';

    function readJson(k, fallback) {
        try {
            const raw = localStorage.getItem(k);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }
    function writeJson(k, v) {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function localDay(ts) {
        const d = new Date(ts || Date.now());
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }
    function hourKey(ts) {
        const d = new Date(ts || Date.now());
        return localDay(ts) + 'T' + pad(d.getHours());
    }
    function hourStart(key) {
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(key);
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4]).getTime() : 0;
    }

    function randomId() {
        try {
            const c = window.crypto || W.crypto;
            if (c && c.randomUUID) return c.randomUUID();
        } catch (e) {}
        return 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    function deviceId() {
        try {
            let id = localStorage.getItem(DEVICE_KEY);
            if (!id) { id = randomId(); localStorage.setItem(DEVICE_KEY, id); }
            return id;
        } catch (e) {
            return 'unknown';
        }
    }

    /* ------------------------------------------------------------------
       Stand down when auto process is already here
    ------------------------------------------------------------------ */
    function autoProcessRunning() {
        // Its toggle button is on the page whenever it is running here.
        if (document.getElementById(AP_TOGGLE_ID)) return true;
        // On a page it has not painted yet, a recent check-in of its own is
        // just as good a sign. Its key is per browser, not per operator.
        const last = readJson(AP_CHECKIN_KEY, null);
        const at = (last && (last.at || last.time || last)) || 0;
        return typeof at === 'number' && Date.now() - at < AP_ALIVE_MS;
    }

    /* ------------------------------------------------------------------
       Who is signed in
    ------------------------------------------------------------------ */
    function userId() {
        if (W.currentUserId) {
            try { localStorage.setItem(LAST_USER_KEY, String(W.currentUserId)); } catch (e) {}
            return String(W.currentUserId);
        }
        try { return localStorage.getItem(LAST_USER_KEY) || 'unknown'; } catch (e) { return 'unknown'; }
    }
    function userName() {
        const el = document.getElementById('UserFullName');
        const raw = el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '';
        return raw || null;
    }
    function userRole() {
        const m = /\(([^)]+)\)\s*$/.exec(userName() || '');
        return m ? m[1] : null;
    }

    /* ------------------------------------------------------------------
       Daily totals, reset at midnight
    ------------------------------------------------------------------ */
    function blankDaily(day) {
        return { day: day, alarms: 0, alarmMs: 0, manual: 0, satMs: 0, satN: 0, onlineMs: 0 };
    }
    function readDaily() {
        const today = localDay();
        const d = readJson(DAILY_KEY, null);
        return (d && d.day === today) ? d : blankDaily(today);
    }
    function saveDaily(d) { writeJson(DAILY_KEY, d); }

    /* ------------------------------------------------------------------
       Hourly buckets. Each finished hour rides along on the next check-in
       and is saved whole, so a resend cannot double count.
    ------------------------------------------------------------------ */
    const HOURS_KEEP_MS = 48 * 60 * 60 * 1000;
    const HOURS_SENT_KEEP_MS = 3 * 60 * 60 * 1000;
    const HOURS_PER_CHECKIN = 6;
    const SUM_FIELDS = ['arrivals', 'alarms', 'alarmMs', 'manual', 'idleMs', 'idleN', 'onlineMs'];

    function readHours() { return readJson(HOURS_KEY, {}) || {}; }

    function hourAdd(field, amount, ts) {
        if (!amount) return;
        const k = hourKey(ts);
        const all = readHours();
        const b = all[k] || (all[k] = { peak: 0, sentAt: 0, dirty: true });
        if (field === 'peak') b.peak = Math.max(b.peak || 0, amount);
        else b[field] = (b[field] || 0) + amount;
        b.dirty = true;

        // Forget hours that were sent a while ago, and give up on any that
        // never made it after two days.
        const now = Date.now();
        Object.keys(all).forEach(function (key) {
            const age = now - hourStart(key);
            if (age > HOURS_KEEP_MS) delete all[key];
            else if (!all[key].dirty && all[key].sentAt && now - all[key].sentAt > HOURS_SENT_KEEP_MS) delete all[key];
        });
        writeJson(HOURS_KEY, all);
    }

    function hoursToSend() {
        const all = readHours();
        const current = hourKey();
        const out = [];
        Object.keys(all).sort().forEach(function (k) {
            if (k >= current || out.length >= HOURS_PER_CHECKIN) return;
            const b = all[k];
            if (!b.dirty) return;
            const row = { key: k, peak: b.peak || 0 };
            SUM_FIELDS.forEach(function (f) { row[f] = b[f] || 0; });
            out.push(row);
        });
        return out;
    }

    function markHoursSent(keys) {
        if (!keys || !keys.length) return;
        const all = readHours();
        keys.forEach(function (k) { if (all[k]) { all[k].dirty = false; all[k].sentAt = Date.now(); } });
        writeJson(HOURS_KEY, all);
    }

    /* ------------------------------------------------------------------
       Watching the page
    ------------------------------------------------------------------ */
    function queueSize() {
        const body = document.getElementById('alarmTable');
        return body ? body.querySelectorAll('tr').length : 0;
    }

    let lastTickAt = 0;
    let lastQueueSeen = null;
    let alarmSeenAt = null;     // when the queue first showed an alarm

    function observe(now, size) {
        // Time on the page. A long gap means the machine was asleep or the
        // tab was frozen, which is not time worked.
        if (lastTickAt) {
            const dt = now - lastTickAt;
            if (dt > 0 && dt < MAX_TICK_GAP_MS) {
                hourAdd('onlineMs', dt, now);
                const d = readDaily();
                d.onlineMs += dt;
                saveDaily(d);
            }
        }
        lastTickAt = now;

        // Alarms entering the queue: every rise counts. The last size is kept
        // across page loads, so alarms that arrived while this browser was
        // inside an alarm are caught on the way back. Same rule as the auto
        // process script, so the two agree on what the queue did.
        if (lastQueueSeen === null) {
            const stored = readJson(QUEUE_KEY, null);
            lastQueueSeen = (stored && now - stored.at < 10 * 60 * 1000) ? stored.size : size;
        }
        if (size > lastQueueSeen) hourAdd('arrivals', size - lastQueueSeen, now);
        if (size !== lastQueueSeen) {
            lastQueueSeen = size;
            writeJson(QUEUE_KEY, { size: size, at: now });
        }
        hourAdd('peak', size, now);

        // How long the queue has had something in it, for the idle figure.
        if (size > 0) { if (alarmSeenAt === null) alarmSeenAt = now; }
        else alarmSeenAt = null;
    }

    /* ------------------------------------------------------------------
       Alarm sessions. SiteMonitor stamps the start, Alarm Monitor banks it
       on the way back. Exactly how the auto process script measures it.
    ------------------------------------------------------------------ */
    function closeOutPending() {
        const pending = readJson(PENDING_KEY, null);
        if (!pending || !pending.startedAt) return;
        try { localStorage.removeItem(PENDING_KEY); } catch (e) {}

        const elapsed = Date.now() - pending.startedAt;
        if (elapsed <= 0 || elapsed > MAX_SESSION_MS) return;   // left open overnight: not a real session

        const d = readDaily();
        d.alarms += 1;
        d.alarmMs += elapsed;
        saveDaily(d);
        hourAdd('alarms', 1, pending.startedAt);
        hourAdd('alarmMs', elapsed, pending.startedAt);
    }

    // A pickup by hand. This browser never has auto process, so every pickup
    // is manual and every wait counts toward idle in queue.
    function hookProcessAlarm() {
        const btn = document.querySelector('a.btn-processalarm');
        if (!btn || btn.dataset.trkHooked) return;
        btn.dataset.trkHooked = '1';
        btn.addEventListener('click', function (e) {
            if (!e.isTrusted) return;
            const now = Date.now();
            const waited = alarmSeenAt ? (now - alarmSeenAt) : null;
            const d = readDaily();
            d.manual += 1;
            if (waited !== null && waited >= 0) { d.satMs += waited; d.satN += 1; }
            saveDaily(d);
            hourAdd('manual', 1, now);
            if (waited !== null && waited >= 0) {
                hourAdd('idleMs', waited, now);
                hourAdd('idleN', 1, now);
            }
        }, true);
    }

    /* ------------------------------------------------------------------
       Reporting
    ------------------------------------------------------------------ */
    // The next check-in time lives in storage, so reloading the page or
    // opening a second tab does not start a second stream of requests.
    function dueNow() {
        const next = readJson(CHECKIN_KEY, 0) || 0;
        return Date.now() >= next;
    }
    function scheduleNext(ms) {
        writeJson(CHECKIN_KEY, Date.now() + (ms || CHECKIN_MS));
    }

    let sending = false;
    function checkin() {
        if (sending) return;
        sending = true;
        scheduleNext();   // claim the slot before the request, so tabs do not double up

        const d = readDaily();
        const hours = hoursToSend();
        const body = {
            userId: userId(),
            userName: userName(),
            userRole: userRole(),
            deviceId: deviceId(),
            scriptVersion: SCRIPT_VERSION,
            tzOffsetMin: new Date().getTimezoneOffset(),
            day: d.day,
            alarms: d.alarms,
            alarmMs: d.alarmMs,
            manual: d.manual,
            satMs: d.satMs,
            satN: d.satN,
            onlineMs: d.onlineMs,
            hours: hours
        };

        send(JSON.stringify(body));
    }

    // A failure is never silent. The counters are cumulative for the day and
    // an unsent hour stays dirty, so nothing is lost by a failed attempt, but
    // a tracker that cannot reach the Worker needs to say so in the console.
    function done(status, text) {
        sending = false;
        if (status >= 200 && status < 300) {
            let res = null;
            try { res = JSON.parse(text); } catch (e) {}
            if (res && res.hours_saved) markHoursSent(res.hours_saved);
            if (res && res.saved === false) {
                console.warn('[Immix tracker] the Worker could not save this check-in. ' +
                             'If this keeps happening, the 3.5 tables may be missing: run migrate-3.5.sql.');
            }
            return;
        }
        if (status === 401) {
            console.error('[Immix tracker] the access key was refused (401). Check TELEMETRY_KEY in this script.');
            return;
        }
        console.error('[Immix tracker] check-in failed' + (status ? ' with status ' + status :
                      ' - no response. If this browser is otherwise working, the request was most likely blocked.'));
    }

    function telemetryBase() {
        const saved = readJson(BASE_KEY, null);
        return (saved && TELEMETRY_BASES.indexOf(saved) !== -1) ? saved : TELEMETRY_BASES[0];
    }
    // Only an unreachable host is worth trying elsewhere. A refused key or a
    // server error means the right host answered and had something to say.
    function otherBase(base) {
        const i = TELEMETRY_BASES.indexOf(base);
        return i === -1 ? null : (TELEMETRY_BASES[(i + 1) % TELEMETRY_BASES.length] || null);
    }

    function send(payload, base, allowRetry) {
        base = base || telemetryBase();
        if (allowRetry === undefined) allowRetry = true;
        const url = base + '/tracker';
        const unreachable = function () {
            const next = allowRetry ? otherBase(base) : null;
            if (next) { send(payload, next, false); return; }
            done(0, '');
        };
        // GM_xmlhttpRequest is outside the page, so the Immix page's content
        // security policy does not apply to it.
        if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': TELEMETRY_KEY },
                data: payload,
                timeout: 20000,
                onload: function (r) { writeJson(BASE_KEY, base); done(r.status, r.responseText); },
                onerror: unreachable,
                ontimeout: unreachable
            });
            return;
        }
        // Fallback for an install where the grant did not take effect. It may
        // be blocked by the page, which is what the console message is for.
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': TELEMETRY_KEY }, body: payload })
            .then(function (r) { writeJson(BASE_KEY, base); return r.text().then(function (t) { done(r.status, t); }); })
            .catch(unreachable);
    }

    /* ------------------------------------------------------------------
       Start
    ------------------------------------------------------------------ */
    if (autoProcessRunning()) {
        console.log('[Immix tracker] auto process is running in this browser, standing down.');
        return;
    }

    // SiteMonitor: stamp the alarm and get out of the way.
    if (/sitemonitor\.aspx/i.test(location.pathname)) {
        const eventId = new URLSearchParams(location.search).get('EventId') || 'unknown';
        const pending = readJson(PENDING_KEY, null);
        if (!pending || pending.eventId !== eventId) {
            if (pending) closeOutPending();
            writeJson(PENDING_KEY, { eventId: eventId, startedAt: Date.now() });
        }
        return;
    }

    // Alarm Monitor: bank anything left open, then watch.
    closeOutPending();
    userId();

    setInterval(function () {
        // If auto process gets installed here later, stop reporting.
        if (document.getElementById(AP_TOGGLE_ID)) return;
        const now = Date.now();
        hookProcessAlarm();
        observe(now, queueSize());
        if (dueNow()) checkin();
    }, POLL_MS);

    // A browser that has never reported gets its first slot a few seconds
    // after the page settles, so it appears on the dashboard promptly. Once
    // a slot exists it survives page loads, which matters: agents navigate
    // in and out of alarms all shift, and reporting on every load would
    // multiply the request count for no extra information.
    if (readJson(CHECKIN_KEY, null) === null) scheduleNext(5000);

    console.log('[Immix tracker] ' + SCRIPT_VERSION + ' watching this browser. Auto process is not running here.' +
                ' Reporting as user ' + userId() + ', browser ' + deviceId().slice(0, 8) + '.');
    if (userId() === 'unknown') {
        console.warn('[Immix tracker] this page did not say who is signed in, so this browser will not be ' +
                     'matched to an agent. Reload the Alarm Monitor page after signing in.');
    }
})();
