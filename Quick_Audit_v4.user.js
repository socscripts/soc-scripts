// ==UserScript==
// @name         Quick Audit v4
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Injects a Quick Audit bottom bar on SmartViewPlus EventViewer pages
// @author       Quick Audit
// @match        https://newapp.smartviewplus.com/EventViewer.aspx*
// @match        https://*.smartviewplus.com/EventViewer.aspx*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    // ── Settings defaults ────────────────────────────────────────────────────
    const DEFAULTS = {
        includeHeaders: false,
        tabSeparated:   true,
        includeAlarm:   true,
        autoRun:        false,
    };
    function getSetting(key) { return GM_getValue(key, DEFAULTS[key]); }
    function setSetting(key, val) { GM_setValue(key, val); }

    GM_registerMenuCommand('Quick Audit — Settings', openSettings);

    // ── State ────────────────────────────────────────────────────────────────
    let auditData   = null;
    let alarmAnswer = null;

    // ── Boot ─────────────────────────────────────────────────────────────────
    window.addEventListener('load', () => {
        injectStyles();
        injectBar();
        if (getSetting('autoRun')) setTimeout(runAudit, 2000);
    });

    // ── Styles ───────────────────────────────────────────────────────────────
    function injectStyles() {
        const s = document.createElement('style');
        s.textContent = `
        #qa-bar {
            position:fixed; bottom:0; left:0; right:0; z-index:99999;
            background:#1a2f52; border-top:1.5px solid #2E5280;
            font-family:"Lucida Sans",Arial,sans-serif; font-size:12px;
            box-shadow:0 -3px 12px rgba(0,0,0,0.35);
        }
        #qa-bar * { box-sizing:border-box; }
        #qa-top-row {
            display:flex; align-items:center; gap:7px;
            padding:6px 14px; border-bottom:0.5px solid #2E5280; flex-wrap:wrap;
        }
        #qa-title {
            color:#B5D4F4; font-size:11px; font-weight:bold;
            display:flex; align-items:center; gap:5px;
            letter-spacing:.04em; white-space:nowrap;
        }
        .qa-div { width:1px; height:18px; background:#2E5280; margin:0 2px; flex-shrink:0; }
        .qa-btn {
            height:26px; padding:0 11px; border:none; border-radius:6px;
            font-size:11px; font-weight:bold; cursor:pointer;
            display:flex; align-items:center; gap:4px; white-space:nowrap;
            transition:opacity .15s;
        }
        .qa-btn:active { opacity:.8; }
        #qa-run-btn   { background:#2E75B6; color:#fff; }
        #qa-copy-btn  { background:#0F6E56; color:#E1F5EE; }
        #qa-copy-btn.copied { background:#085041; }
        #qa-yn-label  { color:#5A7FA8; font-size:10px; white-space:nowrap; }
        #qa-yes-btn   { background:#1D9E75; color:#E1F5EE; }
        #qa-yes-btn.active { background:#085041; outline:2px solid #4CDE9A; }
        #qa-no-btn    { background:#A32D2D; color:#FCEBEB; }
        #qa-no-btn.active  { background:#501313; outline:2px solid #F09595; }
        #qa-settings-btn {
            background:none; border:none; color:#5A7FA8;
            font-size:17px; cursor:pointer; line-height:1;
            padding:0 3px; transition:color .15s, transform .2s;
        }
        #qa-settings-btn:hover { color:#B5D4F4; transform:rotate(45deg); }
        #qa-close-btn {
            background:none; border:none; color:#5A7FA8;
            font-size:18px; cursor:pointer; line-height:1;
            padding:0 2px; margin-left:auto;
        }
        #qa-close-btn:hover { color:#B5D4F4; }

        #qa-data-row {
            display:grid;
            grid-template-columns:repeat(8,1fr);
        }
        .qa-cell {
            padding:6px 12px;
            border-right:0.5px solid #2E5280;
        }
        .qa-cell:last-child { border-right:none; }
        .qa-cell-label {
            font-size:9px; color:#5A7FA8;
            text-transform:uppercase; letter-spacing:.06em; margin-bottom:2px;
        }
        .qa-cell-value { font-size:12px; font-weight:bold; color:#E8F2FC; }

        .qa-badge-yes { background:#085041; color:#9FE1CB; font-size:10px; padding:2px 7px; border-radius:99px; font-weight:bold; }
        .qa-badge-no  { background:#633806; color:#FAC775; font-size:10px; padding:2px 7px; border-radius:99px; font-weight:bold; }
        .qa-badge-pend{ background:#2E5280; color:#85B7EB; font-size:10px; padding:2px 7px; border-radius:99px; }
        .qa-badge-warn{ background:#633806; color:#FAC775; font-size:10px; padding:2px 7px; border-radius:99px; font-weight:bold; }
        .qa-badge-ok  { background:#085041; color:#9FE1CB; font-size:10px; padding:2px 7px; border-radius:99px; font-weight:bold; }

        #qa-toast-row { padding:3px 14px 4px; min-height:20px; display:flex; align-items:center; }
        #qa-toast { font-size:10px; display:none; align-items:center; gap:5px; }
        #qa-toast.show { display:flex; }

        /* Settings overlay */
        #qa-settings-overlay {
            display:none; position:fixed; inset:0;
            background:rgba(0,0,0,0.55); z-index:999999;
            align-items:center; justify-content:center;
        }
        #qa-settings-overlay.open { display:flex; }
        #qa-settings-box {
            background:#1a2f52; border:1px solid #2E5280;
            border-radius:10px; width:430px; overflow:hidden; color:#E8F2FC;
        }
        #qa-settings-head {
            background:#0C2244; padding:10px 16px;
            display:flex; align-items:center; justify-content:space-between;
            border-bottom:1px solid #2E5280;
        }
        #qa-settings-head span { font-weight:bold; font-size:13px; color:#B5D4F4; }
        #qa-settings-close {
            background:none; border:none; color:#5A7FA8;
            font-size:20px; cursor:pointer; line-height:1;
        }
        #qa-settings-close:hover { color:#fff; }
        .qa-setting-row {
            display:flex; align-items:center; justify-content:space-between;
            padding:11px 16px; border-bottom:0.5px solid #2E5280; gap:12px;
        }
        .qa-setting-row:last-of-type { border-bottom:none; }
        .qa-setting-lbl  { font-size:12px; color:#E8F2FC; font-weight:bold; }
        .qa-setting-desc { font-size:10px; color:#5A7FA8; margin-top:2px; }
        .qa-toggle {
            width:36px; height:20px; background:#2E5280; border-radius:99px;
            position:relative; cursor:pointer; border:none; flex-shrink:0;
            transition:background .15s;
        }
        .qa-toggle.on { background:#1D9E75; }
        .qa-toggle::after {
            content:''; position:absolute; width:14px; height:14px;
            background:#fff; border-radius:50%; top:3px; left:3px;
            transition:left .15s;
        }
        .qa-toggle.on::after { left:19px; }
        #qa-settings-note {
            font-size:10px; color:#5A7FA8;
            padding:10px 16px 14px; border-top:0.5px solid #2E5280;
        }
        `;
        document.head.appendChild(s);
    }

    // ── Build bar ─────────────────────────────────────────────────────────────
    function injectBar() {
        const bar = document.createElement('div');
        bar.id = 'qa-bar';
        bar.innerHTML = `
            <div id="qa-top-row">
                <span id="qa-title">&#9635; QUICK AUDIT v4</span>
                <div class="qa-div"></div>
                <button class="qa-btn" id="qa-run-btn">&#9654; Run audit</button>
                <div class="qa-div"></div>
                <button class="qa-btn" id="qa-copy-btn">&#10064; Copy for Excel</button>
                <div class="qa-div"></div>
                <span id="qa-yn-label">Alarm closed correctly?</span>
                <button class="qa-btn" id="qa-yes-btn">&#10003; Yes</button>
                <button class="qa-btn" id="qa-no-btn">&#10007; No</button>
                <div class="qa-div"></div>
                <button id="qa-settings-btn" title="Quick Audit settings">&#9881;</button>
                <button id="qa-close-btn" title="Hide panel">&times;</button>
            </div>
            <div id="qa-data-row">
                <div class="qa-cell">
                    <div class="qa-cell-label">Dispatcher</div>
                    <div class="qa-cell-value" id="qa-v-op">—</div>
                </div>
                <div class="qa-cell">
                    <div class="qa-cell-label">Processing start</div>
                    <div class="qa-cell-value" id="qa-v-start">—</div>
                </div>
                <div class="qa-cell">
                    <div class="qa-cell-label">Time to close</div>
                    <div class="qa-cell-value" id="qa-v-ttc">—</div>
                </div>
                <div class="qa-cell">
                    <div class="qa-cell-label">Details opened</div>
                    <div class="qa-cell-value" id="qa-v-det"><span class="qa-badge-pend">—</span></div>
                </div>
                <div class="qa-cell">
                    <div class="qa-cell-label">Incident code</div>
                    <div class="qa-cell-value" id="qa-v-inc">—</div>
                </div>
                <div class="qa-cell">
                    <div class="qa-cell-label">Alarms on site</div>
                    <div class="qa-cell-value" id="qa-v-total">—</div>
                </div>
                <div class="qa-cell">
                    <div class="qa-cell-label">Alarms viewed</div>
                    <div class="qa-cell-value" id="qa-v-viewed">—</div>
                </div>
                <div class="qa-cell">
                    <div class="qa-cell-label">Finished as</div>
                    <div class="qa-cell-value" id="qa-v-outcome">—</div>
                </div>
            </div>
            <div id="qa-toast-row">
                <div id="qa-toast">
                    <span id="qa-toast-icon">✔</span>
                    <span id="qa-toast-msg"></span>
                </div>
            </div>
        `;
        document.body.appendChild(bar);
        document.body.style.paddingBottom = '115px';

        document.getElementById('qa-run-btn').addEventListener('click', runAudit);
        document.getElementById('qa-copy-btn').addEventListener('click', copyForExcel);
        document.getElementById('qa-yes-btn').addEventListener('click', () => setAlarm('yes'));
        document.getElementById('qa-no-btn').addEventListener('click',  () => setAlarm('no'));
        document.getElementById('qa-settings-btn').addEventListener('click', openSettings);
        document.getElementById('qa-close-btn').addEventListener('click', () => {
            document.getElementById('qa-bar').style.display = 'none';
        });

        injectSettingsOverlay();
    }

    // ── Settings overlay ──────────────────────────────────────────────────────
    function injectSettingsOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'qa-settings-overlay';
        overlay.innerHTML = `
            <div id="qa-settings-box">
                <div id="qa-settings-head">
                    <span>Quick Audit v4 — Settings</span>
                    <button id="qa-settings-close">&times;</button>
                </div>
                <div class="qa-setting-row">
                    <div class="qa-setting-text">
                        <div class="qa-setting-lbl">Include headers when copying</div>
                        <div class="qa-setting-desc">Adds a header row above the data when pasting into Excel</div>
                    </div>
                    <button class="qa-toggle ${getSetting('includeHeaders') ? 'on':''}"
                            id="tog-includeHeaders" data-key="includeHeaders"></button>
                </div>
                <div class="qa-setting-row">
                    <div class="qa-setting-text">
                        <div class="qa-setting-lbl">Copy as tab-separated (recommended)</div>
                        <div class="qa-setting-desc">Pastes cleanly into Excel columns. Off = comma-separated.</div>
                    </div>
                    <button class="qa-toggle ${getSetting('tabSeparated') ? 'on':''}"
                            id="tog-tabSeparated" data-key="tabSeparated"></button>
                </div>
                <div class="qa-setting-row">
                    <div class="qa-setting-text">
                        <div class="qa-setting-lbl">Include "Alarm closed correctly" in copy</div>
                        <div class="qa-setting-desc">Appends the Yes / No answer as the last column</div>
                    </div>
                    <button class="qa-toggle ${getSetting('includeAlarm') ? 'on':''}"
                            id="tog-includeAlarm" data-key="includeAlarm"></button>
                </div>
                <div class="qa-setting-row">
                    <div class="qa-setting-text">
                        <div class="qa-setting-lbl">Auto-run audit on page load</div>
                        <div class="qa-setting-desc">Collects data automatically when EventViewer opens</div>
                    </div>
                    <button class="qa-toggle ${getSetting('autoRun') ? 'on':''}"
                            id="tog-autoRun" data-key="autoRun"></button>
                </div>
                <div id="qa-settings-note">
                    Settings persist across sessions via Tampermonkey storage.<br>
                    Open anytime: Tampermonkey icon &rarr; Quick Audit — Settings.
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('qa-settings-close').addEventListener('click', closeSettings);
        overlay.addEventListener('click', e => { if (e.target === overlay) closeSettings(); });

        overlay.querySelectorAll('.qa-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.key;
                const newVal = !getSetting(key);
                setSetting(key, newVal);
                btn.classList.toggle('on', newVal);
            });
        });
    }

    function openSettings()  { document.getElementById('qa-settings-overlay').classList.add('open'); }
    function closeSettings() { document.getElementById('qa-settings-overlay').classList.remove('open'); }

    // ── Collect all event record rows from the live table ─────────────────────
    function collectEventRecords() {
        const rows = document.querySelectorAll('#eventRecordsTable tr');
        const records = [];
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 3) {
                records.push({
                    time:   (cells[1] ? cells[1].innerText.trim() : ''),
                    detail: (cells[2] ? cells[2].innerText.trim() : ''),
                });
            }
        });
        return records;
    }

    function parseRecordTime(str) {
        if (!str) return null;
        const d = new Date(str);
        return isNaN(d.getTime()) ? null : d;
    }

    // ── DISPATCHER only — skip "(Reviewer)" lines ─────────────────────────────
    function findDispatcher(records) {
        for (const r of records) {
            // Must contain (Dispatcher) — explicitly exclude (Reviewer)
            if (/Started Processing by Operator/i.test(r.detail) &&
                /\(Dispatcher\)/i.test(r.detail) &&
                !/\(Reviewer\)/i.test(r.detail)) {
                // Extract the name between "Operator " and " (Dispatcher)"
                const m = r.detail.match(/Started Processing by Operator\s+(.+?)\s*\(Dispatcher\)/i);
                if (m) return m[1].trim();
            }
        }
        return null;
    }

    // ── Processing start time (Dispatcher only) ───────────────────────────────
    function findProcessingStart(records) {
        for (const r of records) {
            if (/Started Processing by Operator/i.test(r.detail) &&
                /\(Dispatcher\)/i.test(r.detail) &&
                !/\(Reviewer\)/i.test(r.detail)) {
                return parseRecordTime(r.time);
            }
        }
        return null;
    }

    // ── Closed time from page header range ────────────────────────────────────
    function findClosedTime(records) {
        // Primary: parse end time from the h4 "StartDate - EndDate" header
        const h4 = document.querySelector('.ui-widget h4');
        if (h4) {
            const text = h4.innerText || '';
            const m = text.match(/[-–]\s*(\d+\/\d+\/\d+\s+[\d:]+\s*[AP]M)/i);
            if (m) {
                const d = new Date(m[1].trim());
                if (!isNaN(d.getTime())) return d;
            }
        }
        // Fallback: last record with a parseable time
        for (let i = records.length - 1; i >= 0; i--) {
            const d = parseRecordTime(records[i].time);
            if (d) return d;
        }
        return null;
    }

    // ── Details opened ────────────────────────────────────────────────────────
    function findDetailsOpened(records) {
        return records.some(r => /Details Viewed/i.test(r.detail));
    }

    // ── Incident code ─────────────────────────────────────────────────────────
    function findIncidentCode(records) {
        for (const r of records) {
            // "Creating new IncidentCode for location ... IncidentCode: 448352"
            let m = r.detail.match(/IncidentCode[:\s]+(\d{4,})/i);
            if (m) return m[1];
            // broader fallback — any 5-6 digit number near "Incident"
            m = r.detail.match(/Incident[^0-9]*(\d{5,6})/i);
            if (m) return m[1];
        }
        return null;
    }

    // ── COUNT alarms on site ──────────────────────────────────────────────────
    // Alarms are records whose detail contains "Alarm" (e.g. "Dwell Alarm",
    // "Motion Alarm") — specifically the initial alarm trigger lines,
    // NOT acknowledged / processing lines.
    function countAlarmsOnSite(records) {
        return records.filter(r => {
            const d = r.detail;
            return /\bAlarm\b/i.test(d) &&
                   !/Alarm acknowledged/i.test(d) &&
                   !/Started Processing/i.test(d) &&
                   !/IncidentCode/i.test(d);
        }).length;
    }

    // ── COUNT alarms the operator actually VIEWED ─────────────────────────────
    // "Camera Viewed" and "Viewed audit media" both count as viewing an alarm.
    function countAlarmsViewed(records) {
        return records.filter(r => {
            const d = r.detail;
            return /Camera Viewed/i.test(d) ||
                   /Viewed audit media/i.test(d);
        }).length;
    }

    // ── Time to close ─────────────────────────────────────────────────────────
    function calcTimeToClose(start, end) {
        if (!start || !end) return null;
        const diffMs = end - start;
        if (diffMs < 0) return null;
        const totalSec = Math.floor(diffMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    }

    function formatTime(date) {
        return date.toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
        });
    }

    // ── Main audit runner ─────────────────────────────────────────────────────
    function runAudit() {
        const records    = collectEventRecords();
        const dispatcher = findDispatcher(records);
        const startTime  = findProcessingStart(records);
        const closedTime = findClosedTime(records);
        const details    = findDetailsOpened(records);
        const incCode    = findIncidentCode(records);
        const ttc        = calcTimeToClose(startTime, closedTime);
        const totalAlarms  = countAlarmsOnSite(records);
        const viewedAlarms = countAlarmsViewed(records);

        // Event outcome — read from the span#eventOutcomeTitle element
        const outcomeEl = document.getElementById('eventOutcomeTitle');
        const outcome   = outcomeEl ? outcomeEl.innerText.trim() : 'Not found';

        // Current page URL (the event link)
        const eventUrl  = window.location.href;

        auditData = {
            dispatcher:    dispatcher    || 'Not found',
            startTime:     startTime     ? formatTime(startTime) : 'Not found',
            timeToClose:   ttc           || 'Not found',
            details:       details,
            incidentCode:  incCode       || 'None',
            totalAlarms:   totalAlarms,
            viewedAlarms:  viewedAlarms,
            outcome:       outcome,
            eventUrl:      eventUrl,
        };

        renderData(auditData);
        showToast('✔ Audit complete', '#4CDE9A');
    }

    // ── Render into bar cells ─────────────────────────────────────────────────
    function renderData(d) {
        document.getElementById('qa-v-op').textContent    = d.dispatcher;
        document.getElementById('qa-v-start').textContent = d.startTime;
        document.getElementById('qa-v-ttc').textContent   = d.timeToClose;
        document.getElementById('qa-v-inc').textContent   = d.incidentCode;
        document.getElementById('qa-v-total').textContent = d.totalAlarms;

        // Details badge
        const detEl = document.getElementById('qa-v-det');
        detEl.innerHTML = d.details
            ? '<span class="qa-badge-yes">Yes</span>'
            : '<span class="qa-badge-no">No</span>';

        // Viewed alarms — highlight if operator missed some
        const viewEl = document.getElementById('qa-v-viewed');
        const allViewed = d.viewedAlarms >= d.totalAlarms;
        viewEl.innerHTML = d.totalAlarms > 0
            ? `<span class="${allViewed ? 'qa-badge-ok' : 'qa-badge-warn'}">${d.viewedAlarms} / ${d.totalAlarms}</span>`
            : `<span class="qa-badge-pend">${d.viewedAlarms} / ${d.totalAlarms}</span>`;

        // Outcome — plain text, truncate long strings so it fits the cell
        const outcomeEl = document.getElementById('qa-v-outcome');
        const outcomeText = d.outcome || '—';
        outcomeEl.textContent = outcomeText;
        outcomeEl.title = outcomeText;
    }

    // ── Yes / No alarm answer ─────────────────────────────────────────────────
    function setAlarm(val) {
        alarmAnswer = val;
        document.getElementById('qa-yes-btn').classList.toggle('active', val === 'yes');
        document.getElementById('qa-no-btn').classList.toggle('active',  val === 'no');
        const msg = val === 'yes'
            ? 'Marked: alarm closed correctly'
            : 'Marked: alarm NOT closed correctly';
        showToast(msg, val === 'yes' ? '#4CDE9A' : '#F09595');
    }

    // ── Copy for Excel ────────────────────────────────────────────────────────
    function copyForExcel() {
        if (!auditData) {
            showToast('Run the audit first', '#F09595');
            return;
        }

        const sep  = getSetting('tabSeparated') ? '\t' : ',';
        const wrap = v => getSetting('tabSeparated')
            ? String(v)
            : `"${String(v).replace(/"/g, '""')}"`;

        const headers = [
            'Dispatcher', 'Processing Start', 'Time to Close',
            'Details Opened', 'Incident Code', 'Alarms on Site', 'Alarms Viewed',
            'Finished As', 'Event URL'
        ];
        const values = [
            wrap(auditData.dispatcher),
            wrap(auditData.startTime),
            wrap(auditData.timeToClose),
            wrap(auditData.details ? 'Yes' : 'No'),
            wrap(auditData.incidentCode),
            wrap(auditData.totalAlarms),
            wrap(`${auditData.viewedAlarms} / ${auditData.totalAlarms}`),
            wrap(auditData.outcome),
            wrap(auditData.eventUrl),
        ];

        if (getSetting('includeAlarm')) {
            headers.push('Alarm Closed Correctly');
            const ans = alarmAnswer === 'yes' ? 'Yes'
                      : alarmAnswer === 'no'  ? 'No'
                      : 'Not answered';
            values.push(wrap(ans));
        }

        let output = '';
        if (getSetting('includeHeaders')) {
            output += headers.map(wrap).join(sep) + '\n';
        }
        output += values.join(sep);

        navigator.clipboard.writeText(output).then(() => {
            const btn = document.getElementById('qa-copy-btn');
            btn.classList.add('copied');
            btn.textContent = '✔ Copied!';
            showToast('Copied — paste directly into Excel (Ctrl+V)', '#4CDE9A');
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.innerHTML = '&#10064; Copy for Excel';
            }, 2000);
        }).catch(() => {
            showToast('Copy failed — check browser clipboard permissions', '#F09595');
        });
    }

    // ── Toast helper ──────────────────────────────────────────────────────────
    let toastTimer = null;
    function showToast(msg, color) {
        const toast = document.getElementById('qa-toast');
        const msgEl = document.getElementById('qa-toast-msg');
        toast.style.color = color || '#4CDE9A';
        msgEl.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
    }

})();
