// ==UserScript==
// @name         Quick Audit v4
// @namespace    http://tampermonkey.net/
// @version      4.3
// @description  Injects a Quick Audit bottom bar on SmartViewPlus EventViewer, Critical Events and Event Search pages
// @author       Quick Audit
// @match        https://newapp.smartviewplus.com/EventViewer.aspx*
// @match        https://newapp.smartviewplus.com/Events_Critical.aspx*
// @match        https://newapp.smartviewplus.com/Event_Search.aspx*
// @match        https://*.smartviewplus.com/EventViewer.aspx*
// @match        https://*.smartviewplus.com/Events_Critical.aspx*
// @match        https://*.smartviewplus.com/Event_Search.aspx*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    // Page globals (eventId, groupId, criticalEvents, callbacks) live on the real window
    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    const PATH = location.pathname.toLowerCase();
    const PAGE = PATH.includes('eventviewer')     ? 'viewer'
               : PATH.includes('events_critical') ? 'critical'
               : PATH.includes('event_search')    ? 'search'
               : 'other';

    const VERIFY_OPTIONS = ['Arrest', 'Verified Detainment'];
    const DATE_RE = /(\d{1,2}\/\d{1,2}\/\d{4})/;

    // ── Settings ─────────────────────────────────────────────────────────────
    const DEFAULTS = { autoRun: false };
    function getSetting(key) { return GM_getValue(key, DEFAULTS[key]); }
    function setSetting(key, val) { GM_setValue(key, val); }

    GM_registerMenuCommand('Quick Audit — Settings', openSettings);

    // ── Site name: typed by the user, starts empty for every event ───────────
    function getSiteInput() { return document.getElementById('qa-site-input'); }
    function clearSiteInput() { getSiteInput().value = ''; }

    // ── State ────────────────────────────────────────────────────────────────
    let auditData    = null;
    let alarmAnswer  = null;
    let verifyChoice = null;   // 'Arrest' | 'Verified Detainment' | null
    let popChoice    = null;   // pending selection inside the Verify popup
    let verifyBusy   = false;
    let lastEventId  = null;

    // ── Boot ─────────────────────────────────────────────────────────────────
    window.addEventListener('load', () => {
        injectStyles();
        injectBar();

        lastEventId = getEventId();
        if (lastEventId && getSetting('autoRun')) autoRunWhenReady(lastEventId);

        // Critical / Search pages swap events without reloading — watch for that
        setInterval(watchEventChange, 1000);
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
        .qa-btn:disabled { opacity:.5; cursor:wait; }
        #qa-run-btn   { background:#2E75B6; color:#fff; }
        #qa-copy-btn  { background:#0F6E56; color:#E1F5EE; }
        #qa-copy-btn.copied { background:#085041; }
        #qa-verify-btn { background:#5B3FA8; color:#EEE8FC; }
        #qa-verify-btn.active { background:#3A2472; outline:2px solid #B9A2F2; }
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
            grid-template-columns:repeat(10,minmax(0,1fr));
        }
        .qa-cell {
            padding:6px 12px; min-width:0;
            border-right:0.5px solid #2E5280;
        }
        .qa-cell:last-child { border-right:none; }
        .qa-cell-label {
            font-size:9px; color:#5A7FA8;
            text-transform:uppercase; letter-spacing:.06em; margin-bottom:2px;
            white-space:nowrap;
        }
        .qa-cell-value {
            font-size:12px; font-weight:bold; color:#E8F2FC;
            white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        }
        #qa-site-input {
            width:100%; height:20px; padding:0 5px;
            background:#0C2244; color:#E8F2FC; border:1px solid #2E5280;
            border-radius:4px; font-size:12px; font-weight:bold; font-family:inherit;
        }
        #qa-site-input:focus { outline:none; border-color:#85B7EB; }
        #qa-site-input::placeholder { color:#5A7FA8; font-weight:normal; }

        .qa-badge-yes { background:#085041; color:#9FE1CB; font-size:10px; padding:2px 7px; border-radius:99px; font-weight:bold; }
        .qa-badge-no  { background:#633806; color:#FAC775; font-size:10px; padding:2px 7px; border-radius:99px; font-weight:bold; }
        .qa-badge-pend{ background:#2E5280; color:#85B7EB; font-size:10px; padding:2px 7px; border-radius:99px; }
        .qa-badge-warn{ background:#633806; color:#FAC775; font-size:10px; padding:2px 7px; border-radius:99px; font-weight:bold; }
        .qa-badge-ok  { background:#085041; color:#9FE1CB; font-size:10px; padding:2px 7px; border-radius:99px; font-weight:bold; }

        #qa-toast-row { padding:3px 14px 4px; min-height:20px; display:flex; align-items:center; }
        #qa-toast { font-size:10px; display:none; align-items:center; gap:5px; }
        #qa-toast.show { display:flex; }

        /* Verify popup (opens upward from the bar) */
        #qa-verify-pop {
            display:none; position:absolute; bottom:100%; margin-bottom:6px;
            width:300px; background:#0C2244; border:1px solid #2E5280;
            border-radius:8px; padding:10px; color:#E8F2FC;
            box-shadow:0 -4px 14px rgba(0,0,0,0.4);
        }
        #qa-verify-pop.open { display:block; }
        .qa-pop-title { font-size:11px; font-weight:bold; color:#B5D4F4; margin-bottom:8px; }
        .qa-pop-opts { display:flex; gap:6px; margin-bottom:8px; }
        .qa-opt {
            flex:1; height:30px; border:1px solid #2E5280; border-radius:6px;
            background:#1a2f52; color:#E8F2FC; font-size:11px; font-weight:bold; cursor:pointer;
        }
        .qa-opt.sel { background:#5B3FA8; border-color:#B9A2F2; }
        #qa-verify-note {
            width:100%; height:54px; resize:vertical; margin-bottom:8px;
            background:#1a2f52; color:#E8F2FC; border:1px solid #2E5280;
            border-radius:6px; padding:5px; font-size:11px; font-family:inherit;
        }
        .qa-pop-actions { display:flex; gap:6px; }
        #qa-verify-apply { background:#5B3FA8; color:#fff; }
        #qa-verify-mark  { background:#2E5280; color:#E8F2FC; }
        #qa-verify-clear { background:none; color:#85B7EB; margin-left:auto; padding:0 4px; }
        .qa-pop-hint { font-size:9px; color:#5A7FA8; margin-top:7px; line-height:1.4; }

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
                <span id="qa-title">&#9635; QUICK AUDIT v4.3</span>
                <div class="qa-div"></div>
                <button class="qa-btn" id="qa-run-btn">&#9654; Run audit</button>
                <div class="qa-div"></div>
                <button class="qa-btn" id="qa-copy-btn">&#10064; Copy for Excel</button>
                <div class="qa-div"></div>
                <button class="qa-btn" id="qa-verify-btn">&#9733; Verify</button>
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
                    <div class="qa-cell-label">Event date</div>
                    <div class="qa-cell-value" id="qa-v-date">—</div>
                </div>
                <div class="qa-cell">
                    <div class="qa-cell-label">Site</div>
                    <input type="text" id="qa-site-input" placeholder="Type site name" autocomplete="off" />
                </div>
                <div class="qa-cell">
                    <div class="qa-cell-label">Dispatcher</div>
                    <div class="qa-cell-value" id="qa-v-op">—</div>
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
                    <div class="qa-cell-label">PAs issued</div>
                    <div class="qa-cell-value" id="qa-v-pa">—</div>
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
            <div id="qa-verify-pop">
                <div class="qa-pop-title">Verify event as</div>
                <div class="qa-pop-opts">
                    ${VERIFY_OPTIONS.map(o => `<button class="qa-opt" data-val="${o}">${o}</button>`).join('')}
                </div>
                <textarea id="qa-verify-note" maxlength="5000" placeholder="Outcome note (optional)"></textarea>
                <div class="qa-pop-actions">
                    <button class="qa-btn" id="qa-verify-apply">Change outcome</button>
                    <button class="qa-btn" id="qa-verify-mark">Mark only</button>
                    <button class="qa-btn" id="qa-verify-clear">Clear</button>
                </div>
                <div class="qa-pop-hint">
                    <b>Change outcome</b> updates the event's outcome in SmartView.<br>
                    <b>Mark only</b> just tags it for the Excel copy.
                </div>
            </div>
        `;
        document.body.appendChild(bar);
        document.body.style.paddingBottom = '115px';

        document.getElementById('qa-run-btn').addEventListener('click', runAudit);
        document.getElementById('qa-copy-btn').addEventListener('click', copyForExcel);
        document.getElementById('qa-verify-btn').addEventListener('click', toggleVerifyPop);
        document.getElementById('qa-yes-btn').addEventListener('click', () => setAlarm('yes'));
        document.getElementById('qa-no-btn').addEventListener('click',  () => setAlarm('no'));
        document.getElementById('qa-settings-btn').addEventListener('click', openSettings);
        document.getElementById('qa-close-btn').addEventListener('click', () => {
            document.getElementById('qa-bar').style.display = 'none';
        });

        // Verify popup wiring
        bar.querySelectorAll('.qa-opt').forEach(btn => {
            btn.addEventListener('click', () => selectPopChoice(btn.dataset.val));
        });
        document.getElementById('qa-verify-apply').addEventListener('click', applyVerifyOutcome);
        document.getElementById('qa-verify-mark').addEventListener('click', () => {
            if (!popChoice) { showToast('Pick Arrest or Verified Detainment first', '#F09595'); return; }
            setVerify(popChoice);
            closeVerifyPop();
            showToast(`Marked as verified: ${popChoice} (outcome not changed)`, '#B9A2F2');
        });
        document.getElementById('qa-verify-clear').addEventListener('click', () => {
            setVerify(null);
            selectPopChoice(null);
            closeVerifyPop();
            showToast('Verify cleared', '#85B7EB');
        });
        document.addEventListener('mousedown', e => {
            const pop = document.getElementById('qa-verify-pop');
            const vbtn = document.getElementById('qa-verify-btn');
            if (pop.classList.contains('open') && !pop.contains(e.target) && !vbtn.contains(e.target)) {
                closeVerifyPop();
            }
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeVerifyPop(); });

        injectSettingsOverlay();
    }

    // ── Settings overlay ──────────────────────────────────────────────────────
    function injectSettingsOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'qa-settings-overlay';
        overlay.innerHTML = `
            <div id="qa-settings-box">
                <div id="qa-settings-head">
                    <span>Quick Audit v4.3 — Settings</span>
                    <button id="qa-settings-close">&times;</button>
                </div>
                <div class="qa-setting-row">
                    <div class="qa-setting-text">
                        <div class="qa-setting-lbl">Auto-run audit when an event loads</div>
                        <div class="qa-setting-desc">EventViewer on open; Critical / Search when you click an event</div>
                    </div>
                    <button class="qa-toggle ${getSetting('autoRun') ? 'on':''}"
                            id="tog-autoRun" data-key="autoRun"></button>
                </div>
                <div id="qa-settings-note">
                    Copy for Excel pastes one row, no header: Date | Site | Incident Code | Verified.<br>
                    Settings persist via Tampermonkey storage.
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

    // ── Which event is on screen? ─────────────────────────────────────────────
    function getEventId() {
        const fromUrl = new URLSearchParams(location.search).get('EventId');
        if (fromUrl) return String(fromUrl);
        const sel = document.querySelector('.SelectedCriticalEvent[eventid], .EventSearchSelected[eventid]');
        if (sel) return sel.getAttribute('eventid');
        if (W.eventId) return String(W.eventId);
        return null;
    }

    function findCriticalItem(eventId) {
        const list = W.criticalEvents;
        if (!list || typeof list.length !== 'number') return null;
        for (let i = 0; i < list.length; i++) {
            if (String(list[i].eventid) === String(eventId)) return list[i];
        }
        return null;
    }

    // Date / site / outcome for the currently displayed event, per page type
    function getEventContext() {
        const ctx = { eventId: getEventId(), siteId: null, date: null, site: null, outcome: null };

        if (PAGE === 'viewer') {
            const h4 = document.querySelector('#mediaContentContainer h4') || document.querySelector('.ui-widget h4');
            const m = h4 && (h4.innerText || '').match(DATE_RE);
            if (m) ctx.date = m[1];
            const o = document.getElementById('eventOutcomeTitle');
            if (o) ctx.outcome = o.innerText.trim();
            if (W.groupId != null) ctx.siteId = String(W.groupId);
        }
        else if (PAGE === 'critical') {
            const li = document.querySelector('#CriticalEventsList li.SelectedCriticalEvent');
            if (li) {
                ctx.siteId = li.getAttribute('siteid');
                const t = li.querySelector('.EventTime');
                const m = t && t.textContent.match(DATE_RE);
                if (m) ctx.date = m[1];

                // Span text is "<site> - <outcome>"
                const span = li.querySelector('.EventOutcome');
                const text = span ? span.textContent.trim() : '';
                const item = findCriticalItem(ctx.eventId);
                if (item && item.outcome && text.endsWith(' - ' + item.outcome)) {
                    ctx.site    = text.slice(0, text.length - item.outcome.length - 3).trim();
                    ctx.outcome = item.outcome;
                } else {
                    const i = text.lastIndexOf(' - ');
                    if (i > 0) { ctx.site = text.slice(0, i).trim(); ctx.outcome = text.slice(i + 3).trim(); }
                }
            }
        }
        else if (PAGE === 'search') {
            const li = document.querySelector('.EventSearchSelected');
            if (li) {
                ctx.siteId = li.getAttribute('siteid');
                // Item text is "<time> - <outcome>"
                const parts = li.textContent.trim().split(/ - (.+)/);
                const m = (parts[0] || '').match(DATE_RE);
                if (m) ctx.date = m[1];
                if (parts[1]) ctx.outcome = parts[1].trim();

                // Parent folder label is "<site> Events List"
                const list = li.closest('ul.EventSearch');
                const folder = list && list.parentElement
                    ? list.parentElement.querySelector('span.siteFolder') : null;
                if (folder) ctx.site = folder.textContent.replace(/\s*Events List\s*$/i, '').trim();
            }
        }
        return ctx;
    }

    // ── Detect event switches on Critical / Search pages ──────────────────────
    function watchEventChange() {
        const id = getEventId();
        if (id === lastEventId) return;
        lastEventId = id;
        resetForNewEvent();
        if (id && getSetting('autoRun')) autoRunWhenReady(id);
    }

    function autoRunWhenReady(id) {
        let lastCount = -1, stable = 0, tries = 0;
        const timer = setInterval(() => {
            tries++;
            if (getEventId() !== id || tries > 50) { clearInterval(timer); return; }
            const count = document.querySelectorAll('#eventRecordsTable tr').length;
            const loader = document.getElementById('divLoadingEventRecords');
            const loading = loader && !loader.classList.contains('hide');
            stable = (count > 0 && count === lastCount && !loading) ? stable + 1 : 0;
            lastCount = count;
            if (stable >= 2) { clearInterval(timer); runAudit(); }
        }, 400);
    }

    function resetForNewEvent() {
        auditData = null;
        alarmAnswer = null;
        setVerify(null);
        selectPopChoice(null);
        closeVerifyPop();
        document.getElementById('qa-yes-btn').classList.remove('active');
        document.getElementById('qa-no-btn').classList.remove('active');
        clearSiteInput();
        ['qa-v-date','qa-v-op','qa-v-ttc','qa-v-inc','qa-v-total','qa-v-pa','qa-v-outcome']
            .forEach(id => { document.getElementById(id).textContent = '—'; });
        document.getElementById('qa-v-det').innerHTML    = '<span class="qa-badge-pend">—</span>';
        document.getElementById('qa-v-viewed').textContent = '—';
    }

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
            if (/Started Processing by Operator/i.test(r.detail) &&
                /\(Dispatcher\)/i.test(r.detail) &&
                !/\(Reviewer\)/i.test(r.detail)) {
                const m = r.detail.match(/Started Processing by Operator\s+(.+?)\s*\(Dispatcher\)/i);
                if (m) return m[1].trim();
            }
        }
        return null;
    }

    // ── Processing start time (used for Time to close) ────────────────────────
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

    // ── Closed time ───────────────────────────────────────────────────────────
    function findClosedTime(records) {
        // EventViewer: end time from the h4 "StartDate - EndDate" header
        if (PAGE === 'viewer') {
            const h4 = document.querySelector('.ui-widget h4');
            if (h4) {
                const m = (h4.innerText || '').match(/[-–]\s*(\d+\/\d+\/\d+\s+[\d:]+\s*[AP]M)/i);
                if (m) {
                    const d = new Date(m[1].trim());
                    if (!isNaN(d.getTime())) return d;
                }
            }
        }
        // Otherwise: last record with a parseable time
        for (let i = records.length - 1; i >= 0; i--) {
            const d = parseRecordTime(records[i].time);
            if (d) return d;
        }
        return null;
    }

    function dateFromRecords(records) {
        for (const r of records) {
            const m = r.time.match(DATE_RE);
            if (m) return m[1];
        }
        return null;
    }

    function findDetailsOpened(records) {
        return records.some(r => /Details Viewed/i.test(r.detail));
    }

    function findIncidentCode(records) {
        for (const r of records) {
            let m = r.detail.match(/IncidentCode[:\s]+(\d{4,})/i);
            if (m) return m[1];
            m = r.detail.match(/Incident[^0-9]*(\d{5,6})/i);
            if (m) return m[1];
        }
        return null;
    }

    function countAlarmsOnSite(records) {
        return records.filter(r => {
            const d = r.detail;
            return /\bAlarm\b/i.test(d) &&
                   !/Alarm acknowledged/i.test(d) &&
                   !/Started Processing/i.test(d) &&
                   !/IncidentCode/i.test(d);
        }).length;
    }

    function countAlarmsViewed(records) {
        return records.filter(r => /Camera Viewed/i.test(r.detail) || /Viewed audit media/i.test(r.detail)).length;
    }

    // ── PAs issued = any record mentioning "Audio" ────────────────────────────
    function countPAsIssued(records) {
        return records.filter(r => /audio/i.test(r.detail)).length;
    }

    function calcTimeToClose(start, end) {
        if (!start || !end) return null;
        const diffMs = end - start;
        if (diffMs < 0) return null;
        const totalSec = Math.floor(diffMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    }

    // ── Main audit runner ─────────────────────────────────────────────────────
    function runAudit() {
        const ctx = getEventContext();
        if (PAGE !== 'viewer' && !ctx.eventId) {
            showToast('Select an event first', '#F09595');
            return;
        }

        const records = collectEventRecords();
        if (!records.length) {
            showToast('No event records loaded yet — try again in a moment', '#F09595');
            return;
        }

        const startTime  = findProcessingStart(records);
        const closedTime = findClosedTime(records);

        auditData = {
            eventId:      ctx.eventId,
            siteId:       ctx.siteId,
            eventDate:    ctx.date || dateFromRecords(records) || 'Not found',
            dispatcher:   findDispatcher(records) || 'Not found',
            timeToClose:  calcTimeToClose(startTime, closedTime) || 'Not found',
            details:      findDetailsOpened(records),
            incidentCode: findIncidentCode(records) || 'None',
            totalAlarms:  countAlarmsOnSite(records),
            viewedAlarms: countAlarmsViewed(records),
            paCount:      countPAsIssued(records),
            outcome:      ctx.outcome || 'Not found',
        };

        renderData(auditData);
        showToast('✔ Audit complete', '#4CDE9A');
    }

    // ── Render into bar cells ─────────────────────────────────────────────────
    function renderData(d) {
        const setText = (id, v) => {
            const el = document.getElementById(id);
            el.textContent = v;
            el.title = String(v);
        };
        setText('qa-v-date',  d.eventDate);
        setText('qa-v-op',    d.dispatcher);
        setText('qa-v-ttc',   d.timeToClose);
        setText('qa-v-inc',   d.incidentCode);
        setText('qa-v-total', d.totalAlarms);
        setText('qa-v-outcome', d.outcome || '—');

        document.getElementById('qa-v-det').innerHTML = d.details
            ? '<span class="qa-badge-yes">Yes</span>'
            : '<span class="qa-badge-no">No</span>';

        const viewEl = document.getElementById('qa-v-viewed');
        const allViewed = d.viewedAlarms >= d.totalAlarms;
        viewEl.innerHTML = d.totalAlarms > 0
            ? `<span class="${allViewed ? 'qa-badge-ok' : 'qa-badge-warn'}">${d.viewedAlarms} / ${d.totalAlarms}</span>`
            : `<span class="qa-badge-pend">${d.viewedAlarms} / ${d.totalAlarms}</span>`;

        document.getElementById('qa-v-pa').innerHTML = d.paCount > 0
            ? `<span class="qa-badge-ok">${d.paCount}</span>`
            : `<span class="qa-badge-pend">0</span>`;
    }

    // ── Yes / No alarm answer ─────────────────────────────────────────────────
    function setAlarm(val) {
        alarmAnswer = val;
        document.getElementById('qa-yes-btn').classList.toggle('active', val === 'yes');
        document.getElementById('qa-no-btn').classList.toggle('active',  val === 'no');
        showToast(val === 'yes' ? 'Marked: alarm closed correctly' : 'Marked: alarm NOT closed correctly',
                  val === 'yes' ? '#4CDE9A' : '#F09595');
    }

    // ── Verify popup ──────────────────────────────────────────────────────────
    function toggleVerifyPop() {
        const pop = document.getElementById('qa-verify-pop');
        if (pop.classList.contains('open')) { closeVerifyPop(); return; }
        const btn = document.getElementById('qa-verify-btn');
        const maxLeft = window.innerWidth - 310;
        pop.style.left = Math.max(8, Math.min(btn.offsetLeft, maxLeft)) + 'px';
        selectPopChoice(verifyChoice);
        pop.classList.add('open');
    }
    function closeVerifyPop() {
        const pop = document.getElementById('qa-verify-pop');
        if (pop) pop.classList.remove('open');
    }
    function selectPopChoice(val) {
        popChoice = val;
        document.querySelectorAll('#qa-verify-pop .qa-opt').forEach(b => {
            b.classList.toggle('sel', b.dataset.val === val);
        });
    }
    function setVerify(val) {
        verifyChoice = val;
        const btn = document.getElementById('qa-verify-btn');
        btn.classList.toggle('active', !!val);
        btn.innerHTML = val ? `&#10003; Verified: ${val}` : '&#9733; Verify';
    }

    // ── Outcome lookup / change (same endpoints the site's own dialog uses) ──
    const norm = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

    async function getJSON(url) {
        const sep = url.includes('?') ? '&' : '?';
        const res = await fetch(`${url}${sep}_=${Date.now()}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        try { const data = JSON.parse(text); return Array.isArray(data) ? data : []; }
        catch (e) { return []; }
    }

    async function findOutcome(eventId, target) {
        const want = norm(target);
        const top = await getJSON(`/ajax/Outcomes.ashx?Action=GetOutcomes&EventId=${encodeURIComponent(eventId)}`);

        for (const o of top) {
            if (norm(o.outcome) === want) return { id: o.outcomeid, name: o.outcome };
        }
        // Not a top-level outcome — look through sub-outcomes
        for (const o of top) {
            const kids = await getJSON(`/ajax/Outcomes.ashx?Action=GetChildOutcomes&OutcomeId=${encodeURIComponent(o.outcomeid)}`);
            for (const k of kids) {
                if (norm(k.outcome) === want || norm(`${o.outcome} (${k.outcome})`) === want) {
                    return { id: k.outcomeid, name: k.outcome };
                }
            }
        }
        return null;
    }

    async function applyVerifyOutcome() {
        if (verifyBusy) return;
        if (!popChoice) { showToast('Pick Arrest or Verified Detainment first', '#F09595'); return; }

        const ctx = getEventContext();
        if (!ctx.eventId) { showToast('Select an event first', '#F09595'); return; }

        const choice = popChoice;
        const note   = document.getElementById('qa-verify-note').value.trim();

        if (ctx.outcome && norm(ctx.outcome) === norm(choice)) {
            setVerify(choice);
            closeVerifyPop();
            showToast(`Outcome is already ${choice} — marked as verified`, '#B9A2F2');
            return;
        }

        if (!confirm(`Change the outcome of event ${ctx.eventId} to "${choice}"?`)) return;

        const applyBtn = document.getElementById('qa-verify-apply');
        verifyBusy = true;
        applyBtn.disabled = true;
        applyBtn.textContent = 'Changing…';

        try {
            const match = await findOutcome(ctx.eventId, choice);
            if (!match) {
                showToast(`No "${choice}" outcome is available for this site — nothing was changed`, '#F09595');
                return;
            }

            const url = `/ajax/Outcomes.ashx?Action=ChangeEventOutcome` +
                        `&EventId=${encodeURIComponent(ctx.eventId)}` +
                        `&OutcomeId=${encodeURIComponent(match.id)}` +
                        `&OutcomeNote=${encodeURIComponent(note)}` +
                        `&_=${Date.now()}`;
            const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            setVerify(choice);
            afterOutcomeChanged(ctx, match, note);
            document.getElementById('qa-verify-note').value = '';
            closeVerifyPop();
            showToast(`✔ Outcome changed to ${match.name}`, '#B9A2F2');
        } catch (e) {
            showToast(`Outcome change failed: ${e.message}`, '#F09595');
        } finally {
            verifyBusy = false;
            applyBtn.disabled = false;
            applyBtn.textContent = 'Change outcome';
        }
    }

    // Refresh the page's own UI after an outcome change
    function afterOutcomeChanged(ctx, match, note) {
        if (typeof W.changeEventOutcomeCallback === 'function') {
            // EventViewer & Event Search: updates the title / list entry and reloads records
            try { W.changeEventOutcomeCallback(match.id, match.name, note); }
            catch (e) { console.warn('[Quick Audit] page callback failed', e); }
        } else if (PAGE === 'critical') {
            const li = document.querySelector('#CriticalEventsList li.SelectedCriticalEvent');
            const span = li && li.querySelector('.EventOutcome');
            if (span) span.textContent = `${ctx.site || ''} - ${match.name}`;
            const item = findCriticalItem(ctx.eventId);
            if (item) item.outcome = match.name;
        }
        if (auditData && auditData.eventId === ctx.eventId) {
            auditData.outcome = match.name;
            renderData(auditData);
        }
    }

    // ── Copy for Excel: Date | Site | Incident Code | Verified — no header ────
    function copyForExcel() {
        if (!auditData) { showToast('Run the audit first', '#F09595'); return; }

        const cur = getEventId();
        if (cur && auditData.eventId && cur !== auditData.eventId) {
            showToast('Selected event changed — run the audit again', '#F09595');
            return;
        }

        const site = getSiteInput().value.trim();

        const clean = v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ').trim();
        const output = [
            auditData.eventDate,     // A: Date
            site,                    // B: Site name (typed)
            auditData.incidentCode,  // C: Incident code
            verifyChoice || '',      // D: Verify selection (blank if not verified)
        ].map(clean).join('\t');

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
