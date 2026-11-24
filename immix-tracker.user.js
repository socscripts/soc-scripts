// ==UserScript==
// @name         Immix Activity Tracker
// @namespace    immix-tracker
// @version      1.1.0
// @description  Records alarm activity and time on the Alarm Monitor page for a browser that does NOT run auto process. Never picks up an alarm. Shows each site's scheduled disarm time in the Armed Sites and Site Check lists. Stands down automatically if the auto process script is running in the same browser.
// @author       -
// @match        *://newapp.smartviewplus.com/AlarmMonitor.aspx*
// @match        *://newapp.smartviewplus.com/SiteMonitor.aspx*
// @match        *://newapp.smartviewplus.com/SiteDetails.aspx*
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

    const SCRIPT_VERSION = '1.1.0';

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
        Object.assign(body, schedCheckinExtras());

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
            // More schedules still to fetch: come back in a few seconds, not three minutes.
            if (res && res.schedules) {
                try { if (schedApplyReply(res.schedules)) scheduleNext(5000); }
                catch (e) { console.warn('[Immix tracker] could not store site schedules:', e); }
            }
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
       Site arming schedules (1.1). The same code as auto process 3.14, with
       this script's own storage keys: Site Details banks the schedule it
       shows, each check-in sends it and brings back everyone's changes, and
       the Armed Sites / Site Check lists show today's scheduled disarm time.
       It never disarms anything.
    ------------------------------------------------------------------ */
    const SCHED_OUT_KEY   = NS + 'schedOut';     // read on Site Details, not yet saved
    const SCHED_CACHE_KEY = NS + 'schedCache';   // everyone's saved schedules
    const SCHED_OUT_MAX   = 50;
    const SCHED_PER_CHECKIN = 20;
    const SCHED_SOON_MIN  = 30;
    const SCHED_DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'holiday'];

    function schedSnap(m) { return Math.min(1440, Math.max(0, Math.round(m / 15) * 15)); }
    // Same rules as the Worker's schedMergeDay and the auto process script.
    function schedMerge(list) {
        const ws = list.filter(function (w) { return w[1] > w[0]; })
                       .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        const out = [];
        ws.forEach(function (w) {
            const last = out[out.length - 1];
            if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
            else out.push([w[0], w[1]]);
        });
        return out;
    }

    // The schedule drawn on this Site Details page, or null if the page
    // doesn't look the way it did when this was written.
    function schedReadPage() {
        const rows = document.querySelectorAll('#tabs-disarm tbody > tr');
        if (rows.length < 8) return null;
        const days = [];
        for (let i = 0; i < 8; i++) {
            const row = rows[i];
            const name = (row.cells[0] && row.cells[0].textContent || '').trim().toLowerCase();
            if (name.indexOf(SCHED_DAY_NAMES[i]) !== 0) return null;
            const sec = row.querySelector('.DisarmSection');
            if (!sec) return null;
            let full = parseFloat(getComputedStyle(sec).width);
            if (!(full > 100)) full = 600;
            const perPx = 1440 / full;
            const list = [];
            row.querySelectorAll('.DisarmPeriod').forEach(function (b) {
                const left = parseFloat(b.style.left), width = parseFloat(b.style.width);
                if (!isFinite(left) || !isFinite(width) || width <= 0) return;
                list.push([schedSnap(left * perPx), schedSnap((left + width) * perPx)]);
            });
            days.push(schedMerge(list));
        }
        return days;
    }

    function schedPageTitle() {
        return String(document.title || '').replace(/^\s*site details\s*:\s*/i, '').trim().slice(0, 160) || null;
    }

    // Everyone's schedules, kept in this browser: { next:{t,g}, sites:{ gid: [title, daysText] } }.
    let schedMem = null;
    function schedCache() {
        if (schedMem) return schedMem;
        const c = readJson(SCHED_CACHE_KEY, null);
        schedMem = (c && c.sites && typeof c.sites === 'object') ? c : { next: { t: 0, g: '' }, sites: {} };
        if (!schedMem.next) schedMem.next = { t: 0, g: '' };
        return schedMem;
    }

    function schedCapture() {
        const q = new URLSearchParams(location.search);
        const gid = String(q.get('groupid') || q.get('groupId') || q.get('GroupId') || '');
        if (!/^\d{1,12}$/.test(gid)) return;
        const days = schedReadPage();
        if (!days) return;
        const text = JSON.stringify(days);
        const known = readJson(SCHED_CACHE_KEY, null);   // fresh from storage, not the in-memory copy
        if (known && known.sites && known.sites[gid] && known.sites[gid][1] === text) return;
        const out = readJson(SCHED_OUT_KEY, {});
        if (out[gid] && JSON.stringify(out[gid].days) === text) return;
        out[gid] = { groupId: gid, title: schedPageTitle(), days: days, at: Date.now() };
        const keys = Object.keys(out).sort(function (a, b) { return out[b].at - out[a].at; });
        keys.slice(SCHED_OUT_MAX).forEach(function (k) { delete out[k]; });
        writeJson(SCHED_OUT_KEY, out);
    }

    // What rides on a check-in, and when each item was banked, so the reply
    // clears only those not banked again since.
    const schedSentAt = {};
    function schedCheckinExtras() {
        const out = readJson(SCHED_OUT_KEY, {});
        const list = Object.keys(out).map(function (k) { return out[k]; })
            .sort(function (a, b) { return a.at - b.at; }).slice(0, SCHED_PER_CHECKIN);
        list.forEach(function (x) { schedSentAt[x.groupId] = x.at; });
        const extra = { schedSince: schedCache().next };
        if (list.length) extra.schedules = list.map(function (x) { return { groupId: x.groupId, title: x.title, days: x.days }; });
        return extra;
    }

    // Returns true while there are more rows to fetch, so the caller checks
    // in again soon instead of waiting the full interval.
    function schedApplyReply(r) {
        if (!r || typeof r !== 'object') return false;
        if (Array.isArray(r.saved) && r.saved.length) {
            const out = readJson(SCHED_OUT_KEY, {});
            r.saved.forEach(function (gid) {
                if (out[gid] && out[gid].at === schedSentAt[gid]) delete out[gid];
                delete schedSentAt[gid];
            });
            writeJson(SCHED_OUT_KEY, out);
        }
        const c = schedCache();
        if (Array.isArray(r.rows)) {
            r.rows.forEach(function (row) {
                if (Array.isArray(row) && row[0]) c.sites[String(row[0])] = [String(row[1] || ''), String(row[2] || '')];
            });
        }
        if (r.next && typeof r.next === 'object') c.next = { t: Number(r.next.t) || 0, g: String(r.next.g || '') };
        c.ver = (c.ver || 0) + (Array.isArray(r.rows) && r.rows.length ? 1 : 0);
        try { localStorage.setItem(SCHED_CACHE_KEY, JSON.stringify(c)); } catch (e) {}
        return !!r.more;
    }

    function schedFmt(m) {
        m = ((m % 1440) + 1440) % 1440;
        const h = Math.floor(m / 60), mm = m % 60;
        return (h % 12 || 12) + ':' + (mm < 10 ? '0' : '') + mm + (h < 12 ? ' AM' : ' PM');
    }
    // Same as the Worker's schedStarts: a window that carries on from the day
    // before is not a new disarm.
    function schedStartsOn(days, dow) {
        const today = days[dow] || [], prev = days[(dow + 6) % 7] || [];
        const carried = prev.some(function (w) { return w[1] >= 1440; });
        return today.filter(function (w) { return !(w[0] === 0 && carried); }).map(function (w) { return w[0]; });
    }
    const schedParsed = {};
    function schedDays(text) {
        if (!(text in schedParsed)) {
            let d = null;
            try { d = JSON.parse(text); } catch (e) {}
            schedParsed[text] = Array.isArray(d) ? d : null;
        }
        return schedParsed[text];
    }

    function schedLabel(entry, now) {
        const days = entry ? schedDays(entry[1]) : null;
        if (!days) return { text: 'schedule not saved yet', cls: 'ap-unk' };
        const dow = (now.getDay() + 6) % 7, min = now.getHours() * 60 + now.getMinutes();
        const starts = schedStartsOn(days, dow);
        if (!starts.length) return { text: 'No scheduled disarm today', cls: 'ap-none' };
        const soon = starts.filter(function (s) { return s > min && s - min <= SCHED_SOON_MIN; })[0];
        if (soon !== undefined) return { text: 'Scheduled disarm ' + schedFmt(soon) + ' \u00b7 in ' + (soon - min) + ' min', cls: 'ap-soon' };
        return { text: 'Scheduled disarm ' + starts.map(schedFmt).join(', '), cls: 'ap-dis' };
    }

    function schedStyle() {
        if (document.getElementById('ap-sched-style')) return;
        const st = document.createElement('style');
        st.id = 'ap-sched-style';
        st.textContent =
            '.ap-sched{display:inline-block;margin-left:8px;padding:0 7px;border-radius:9px;font-size:11px;' +
            'line-height:16px;vertical-align:middle;white-space:nowrap;pointer-events:none}' +
            '.ap-sched.ap-dis{background:#4d3b10;color:#ffd27a}' +
            '.ap-sched.ap-soon{background:#6b1d1d;color:#ffb3b3}' +
            '.ap-sched.ap-none,.ap-sched.ap-unk{color:#8f8f8f;padding:0 2px}';
        (document.head || document.documentElement).appendChild(st);
    }

    // Runs every second; does nothing unless Armed Sites, Disarmed Sites or
    // Site Check is open. Each site's label is redone only when the minute
    // or the saved schedules change, or Immix redraws the list.
    function schedDecorate() {
        const box = document.getElementById('site-select');
        if (!box || !box.offsetParent) return;
        schedStyle();
        const c = schedCache(), now = new Date();
        const stamp = (c.ver || 0) + ':' + now.getDate() + ':' + (now.getHours() * 60 + now.getMinutes());
        box.querySelectorAll('span.siteNode').forEach(function (sp) {
            if (!sp.id || sp.getAttribute('data-ap-sched') === stamp) return;
            sp.setAttribute('data-ap-sched', stamp);
            let pill = sp.nextElementSibling;
            if (!pill || !pill.classList.contains('ap-sched')) {
                pill = document.createElement('span');
                sp.parentNode.insertBefore(pill, sp.nextSibling);
            }
            const info = schedLabel(c.sites[sp.id], now);
            pill.className = 'ap-sched ' + info.cls;
            pill.textContent = info.text;
        });
    }

    /* ------------------------------------------------------------------
       Start
    ------------------------------------------------------------------ */
    if (autoProcessRunning()) {
        console.log('[Immix tracker] auto process is running in this browser, standing down.');
        return;
    }

    // Site Details: bank the arming schedule for the next check-in.
    if (/sitedetails\.aspx/i.test(location.pathname)) {
        try { schedCapture(); } catch (e) { console.warn('[Immix tracker] could not read the arming schedule:', e); }
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

    // Disarm times in the site lists. An error is reported once, not every second.
    let schedWarned = false;
    setInterval(function () {
        if (document.getElementById(AP_TOGGLE_ID)) return;   // auto process shows its own
        try { schedDecorate(); }
        catch (e) { if (!schedWarned) { schedWarned = true; console.warn('[Immix tracker] site list disarm times:', e); } }
    }, 1000);

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
