// ==UserScript==
// @name         Immix Alarm Monitor - Auto Process v_5
// @namespace    smartviewplus.autoprocess
// @version      1.9
// @description  Auto-process toggle with selectable speed (default/fast/slow), idle timer that resets when the queue empties, per-operator alarm stats (auto-reset at midnight) for the Immix Alarm Monitor.
// @author       you
// @match        https://newapp.smartviewplus.com/AlarmMonitor.aspx*
// @match        https://newapp.smartviewplus.com/SiteMonitor.aspx*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

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
       Storage - everything except the operator pointer is keyed per user
    ------------------------------------------------------------------ */
    const LAST_USER_KEY = 'immixAutoProcessLastUser';

    function uid() {
        if (window.currentUserId) return String(window.currentUserId);
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
        if (elapsed <= 0 || elapsed > MAX_SESSION_MS) return false;

        const stats = getStats();
        stats.count += 1;
        stats.totalMs += elapsed;
        write('stats', stats);
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
       SiteMonitor - stamp the start of an event, then get out of the way
    ================================================================== */
    if (/sitemonitor\.aspx/i.test(location.pathname)) {
        const eventId = new URLSearchParams(location.search).get('EventId') || 'unknown';
        const pending = read('pending', null);

        if (!pending || pending.eventId !== eventId) {
            // A different event was left open; bank it before starting this one.
            if (pending) closeOutPending();
            write('pending', { eventId: eventId, startedAt: Date.now() });
        }
        return;
    }

    /* ==================================================================
       AlarmMonitor
    ================================================================== */

    // Remember who is signed in so SiteMonitor can use the same keys.
    if (window.currentUserId) {
        try { localStorage.setItem(LAST_USER_KEY, String(window.currentUserId)); } catch (e) {}
    }

    checkDailyReset();

    let enabled      = read('enabled', false) === true;
    let speed        = normalizeSpeed(read('speed', DEFAULT_SPEED));
    let lastAction   = 0;
    let currentTint  = null;
    let alarmSeenAt  = null;   // when the current queue first showed an alarm
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
            setEnabled(!enabled);
        });

        li.appendChild(button);
        stats.insertBefore(li, stats.firstChild);
        paintButton();
    }

    function paintButton() {
        if (!button) return;
        button.textContent = enabled ? 'Auto process: on' : 'Auto process: off';
        button.style.backgroundColor = enabled ? ON_COLOR : OFF_COLOR;
    }

    function setEnabled(value) {
        enabled = value;
        write('enabled', enabled);
        if (enabled) {
            lastAction = Date.now();
        } else {
            restartTimer();   // clock picks up from the moment you take over
        }
        paintButton();
        paintPanel();
        applyTint(tintForNow());
    }

    function setSpeed(value) {
        speed = normalizeSpeed(value);
        write('speed', speed);
        alarmSeenAt = null;   // re-measure the current alarm against the new delay
        paintPanel();
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
                write('stats', { count: 0, totalMs: 0 });
                paintPanel();
            }
        });

        paintPanel();
    }

    function paintPanel() {
        if (!panel) return;

        if (enabled) {
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
        if (window.redirectingToSiteMonitor === true) return true;
        if (window._currentlyRequestingHandleEvent === true) return true;
        if (window.eventHandleInProgress === true) return true;
        if (window.alarmMonitor && window.alarmMonitor.update === false) return true;

        const smw = window.alarmMonitor && window.alarmMonitor.siteMonitorWindow;
        if (smw && !smw.closed) return true;

        if (dialogOpen()) return true;
        if (connectionError()) return true;
        return false;
    }

    /* ------------------------------------------------------------------
       Main loop
    ------------------------------------------------------------------ */
    function tick() {
        checkDailyReset();

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
        if (typeof window.handleFirstAlarm !== 'function') return;
        if (busy() || !hasAlarm) return;
        if (now - alarmSeenAt < pickupDelayMs()) return;   // let it sit the chosen delay

        lastAction = now;
        alarmSeenAt = null;
        try {
            window.handleFirstAlarm();
        } catch (err) {
            console.error('[Auto process] handleFirstAlarm failed:', err);
        }
    }

    createButton();
    createPanel();
    hookProcessAlarm();
    setInterval(tick, POLL_MS);
})();
