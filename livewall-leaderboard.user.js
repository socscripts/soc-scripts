// ==UserScript==
// @name         Livewall Leaderboard
// @namespace    livewall-leaderboard
// @version      1.0.0
// @description  Restyles the Livewall queue status page and adds a top-3 performers panel fed by the Immix telemetry Worker.
// @author       -
// @match        file:///*queue-status.html*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      immix-telemetry.soc-autoprocess.workers.dev
// @connect      immix-telemetry.jdale-e67.workers.dev
// @updateURL    https://raw.githubusercontent.com/socscripts/soc-scripts/main/livewall-leaderboard.user.js
// @downloadURL  https://raw.githubusercontent.com/socscripts/soc-scripts/main/livewall-leaderboard.user.js
// ==/UserScript==

/*
 *  What this does
 *  --------------
 *  The queue status page keeps working exactly as before: its own script
 *  still reads the four numbers from the local server every second and
 *  still colors each box. This script only changes how the page looks and
 *  adds a panel on the right showing the top three agents of the shift so
 *  far, rotating between share of workload, time to close vs peers, and
 *  alarms handled.
 *
 *  The leaderboard comes from the Worker's read-only /api/leaderboard
 *  endpoint every 2 minutes (720 requests a day). The key below is the
 *  LEADERBOARD_KEY secret, not the agents' key: it can read the top three
 *  and nothing else.
 *
 *  Requires Tampermonkey's "Allow access to file URLs" to be on.
 */

(function () {
    'use strict';

    const LEADERBOARD_KEY = 'PASTE_LEADERBOARD_KEY_HERE';
    const BASES = [
        'https://immix-telemetry.soc-autoprocess.workers.dev',
        'https://immix-telemetry.jdale-e67.workers.dev'
    ];
    const POLL_MS = 2 * 60 * 1000;
    const ROTATE_MS = 10 * 1000;

    const COLORS = { ok: '#3DD68C', warn: '#FF801F', crit: '#DC3E42' };

    const VIEWS = [
        { key: 'share',  label: 'Share of workload',      overline: function (d) { return 'SHARE OF WORKLOAD \u00b7 100% = EVEN SPLIT' + through(d); } },
        { key: 'close',  label: 'Time to close vs peers', overline: function (d) { return 'AVERAGE TIME TO CLOSE' + (d && d.floor_close ? ' \u00b7 FLOOR AVG ' + d.floor_close : '') + through(d); } },
        { key: 'alarms', label: 'Alarms handled',         overline: function () { return 'ALARMS HANDLED \u00b7 SHIFT SO FAR'; } }
    ];

    function through(d) { return d && d.through ? ' \u00b7 THROUGH ' + d.through : ''; }

    /* ------------------------------------------------------------------ styles */

    const css = `
    body { background: #0A0A0A !important; }
    * { font-family: Inter, 'Segoe UI', Arial, sans-serif; }
    .mainContainer {
        grid-template-columns: 1fr 1fr 2fr !important;
        grid-template-rows: 1fr 1fr !important;
        grid-template-areas: "a b lb" "c d lb" !important;
        gap: 1.1vh !important; padding: 1.1vh !important;
        background: #0A0A0A;
    }
    #oldestQueueEventDiv  { grid-area: a; }
    #oldestParkedEventDiv { grid-area: b; }
    #eventsInQueueDiv     { grid-area: c; }
    #averageAgeInQueueDiv { grid-area: d; }
    .mainContainer > .grid-item {
        background: #171717 !important;
        border: 1px solid #404040 !important;
        border-top: 1vh solid var(--lw-state, #404040) !important;
        border-radius: 14px;
        transition: border-color .4s;
    }
    .mainContainer > .grid-item .divTitle {
        font-family: Geist, Inter, sans-serif; font-weight: 600;
        font-size: 2.6vh; color: #D4D4D4; margin: 2.6vh 1vw 0; position: relative; z-index: 1;
    }
    .mainContainer > .grid-item .contentDiv {
        font-family: 'Geist Mono', Consolas, monospace; font-weight: 600;
        font-size: 9.6vh; letter-spacing: -0.15vh; color: var(--lw-state, #FAFAFA);
        display: flex; align-items: center; justify-content: center;
    }
    #eventsInQueue { font-size: 13vh !important; }
    .lw-status {
        position: absolute; left: 0; right: 0; bottom: 3.2vh; z-index: 1;
        display: flex; align-items: center; justify-content: center; gap: .6vw;
        font-size: 1.9vh; font-weight: 600; color: #FAFAFA;
    }
    .lw-status svg { width: 1.3vh; height: 1.3vh; }

    #lwBoard {
        grid-area: lb; background: #171717; border: 1px solid #404040; border-radius: 14px;
        padding: 3vh 1.9vw; box-sizing: border-box; display: flex; flex-direction: column; gap: 2.6vh;
        color: #FAFAFA; overflow: hidden; min-height: 0;
    }
    .lw-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 1vw; }
    .lw-over { font-size: 1.3vh; font-weight: 600; letter-spacing: .2vh; color: #A3A3A3; }
    .lw-title { font-family: Geist, Inter, sans-serif; font-weight: 700; font-size: 3.7vh; margin-top: .6vh; }
    .lw-right { text-align: right; }
    .lw-hours { font-family: 'Geist Mono', Consolas, monospace; font-size: 2vh; color: #D4D4D4; }
    .lw-into { font-size: 1.5vh; color: #A3A3A3; margin-top: .6vh; }
    .lw-bar { height: .6vh; background: #262626; border-radius: 9999px; overflow: hidden; }
    .lw-bar > div { height: 100%; width: 0; background: #0090FF; border-radius: 9999px; }
    .lw-podium { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: .85vw; align-items: end; }
    .lw-card { background: #262626; border-radius: 14px; padding: 2.6vh 1.25vw; box-sizing: border-box;
               display: flex; flex-direction: column; justify-content: space-between; min-width: 0; }
    .lw-card.p1 { background: #0369A1; height: 100%; }
    .lw-card.p2 { height: 78%; }
    .lw-card.p3 { height: 64%; }
    .lw-place { font-family: 'Geist Mono', Consolas, monospace; font-size: 2.4vh; color: #A3A3A3; }
    .lw-card.p1 .lw-place, .lw-card.p1 .lw-note { color: #E0F2FE; }
    .lw-name { font-family: Geist, Inter, sans-serif; font-weight: 600; font-size: 3vh;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lw-card.p1 .lw-name { font-weight: 700; font-size: 3.5vh; }
    .lw-value { font-family: 'Geist Mono', Consolas, monospace; font-weight: 600; font-size: 5.2vh; margin: .9vh 0; }
    .lw-card.p1 .lw-value { font-size: 6.7vh; }
    .lw-card.p3 .lw-value { font-size: 4.6vh; }
    .lw-note { font-size: 1.7vh; color: #A3A3A3; }
    .lw-empty { grid-column: 1 / -1; align-self: center; text-align: center; font-size: 2.4vh; color: #A3A3A3; }
    .lw-tabs { display: flex; gap: .5vw; }
    .lw-tab { flex: 1; min-height: 4.4vh; border-radius: 9999px; border: 1px solid #404040; background: transparent;
              color: #FAFAFA; font-size: 1.6vh; font-weight: 600; cursor: pointer; }
    .lw-tab.on { background: #0369A1; border-color: #0369A1; }
    .lw-foot { display: flex; justify-content: space-between; font-size: 1.5vh; color: #A3A3A3;
               border-top: 1px solid #404040; padding-top: 1.3vh; }
    .lw-foot .lw-mono { font-family: 'Geist Mono', Consolas, monospace; }
    .lw-warn { color: #FF801F; }
    `;

    const fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href = 'https://fonts.googleapis.com/css2?family=Geist:wght@500;600;700&family=Geist+Mono:wght@500;600&family=Inter:wght@400;500;600&display=swap';
    document.head.appendChild(fonts);
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const container = document.querySelector('.mainContainer');
    if (!container) { console.error('[Livewall] .mainContainer not found; the page layout has changed.'); return; }

    /* ------------------------------------------------------------------ queue tiles */

    // The page's own script paints each box red, orange or green every second
    // through an inline background. That background is hidden by the styles
    // above; here it is read back and turned into the top band, number color
    // and status label.
    const SHAPES = {
        ok:   '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="7" fill="' + COLORS.ok + '"/></svg>',
        warn: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 0 L14 13 L0 13 Z" fill="' + COLORS.warn + '"/></svg>',
        crit: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect width="14" height="14" fill="' + COLORS.crit + '"/></svg>'
    };
    const LABELS = { ok: 'Normal', warn: 'Warning', crit: 'Critical' };

    function stateOf(tile) {
        const bg = (tile.style.background || tile.style.backgroundColor || '').toLowerCase();
        if (bg.indexOf('red') !== -1) return 'crit';
        if (bg.indexOf('orange') !== -1) return 'warn';
        if (bg.indexOf('green') !== -1) return 'ok';
        return null;
    }

    function paint(tile) {
        const s = stateOf(tile);
        if (tile.dataset.lwState === (s || '')) return;
        tile.dataset.lwState = s || '';
        tile.style.setProperty('--lw-state', s ? COLORS[s] : '#404040');
        let label = tile.querySelector('.lw-status');
        if (!label) {
            label = document.createElement('div');
            label.className = 'lw-status';
            tile.appendChild(label);
        }
        label.innerHTML = s ? SHAPES[s] + LABELS[s] : '';
    }

    const tiles = Array.prototype.slice.call(container.querySelectorAll(':scope > .grid-item'));
    const tileWatch = new MutationObserver(function (list) { list.forEach(function (m) { paint(m.target); }); });
    tiles.forEach(function (t) { paint(t); tileWatch.observe(t, { attributes: true, attributeFilter: ['style'] }); });

    /* ------------------------------------------------------------------ leaderboard panel */

    const board = document.createElement('div');
    board.id = 'lwBoard';
    board.innerHTML =
        '<div class="lw-head"><div><div class="lw-over" id="lwOver"></div>' +
        '<div class="lw-title" id="lwTitle">Top performers</div></div>' +
        '<div class="lw-right"><div class="lw-hours" id="lwHours"></div><div class="lw-into" id="lwInto"></div></div></div>' +
        '<div class="lw-bar"><div id="lwProg"></div></div>' +
        '<div class="lw-podium" id="lwPodium"></div>' +
        '<div class="lw-tabs" id="lwTabs"></div>' +
        '<div class="lw-foot"><div id="lwFootL">Shift so far \u00b7 both browsers combined</div>' +
        '<div class="lw-mono" id="lwFootR"></div></div>';
    container.appendChild(board);

    const $ = function (id) { return document.getElementById(id); };
    let data = null, view = 0, viewStarted = Date.now(), lastOk = 0, lastError = '';

    VIEWS.forEach(function (v, i) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lw-tab';
        b.textContent = v.label;
        b.onclick = function () { view = i; viewStarted = Date.now(); render(); };
        $('lwTabs').appendChild(b);
    });

    // Shift name and hours from the wall's own clock, so they are right even
    // before the first answer arrives. Same rule as the Worker.
    function localShift(now) {
        const m = now.getHours() * 60 + now.getMinutes();
        let name, hours, startMin;
        if (m >= 360 && m < 840)       { name = '1st shift'; hours = '6:00 AM \u2013 2:30 PM';  startMin = 360; }
        else if (m >= 840 && m < 1320) { name = '2nd shift'; hours = '2:00 PM \u2013 10:30 PM'; startMin = 840; }
        else                           { name = '3rd shift'; hours = '10:00 PM \u2013 6:30 AM'; startMin = 1320; }
        const into = (m - startMin + 1440) % 1440;
        return { name: name, hours: hours, into: Math.floor(into / 60) + 'h ' + (into % 60) + 'm into shift' };
    }

    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function render() {
        const sh = localShift(new Date());
        const v = VIEWS[view];
        $('lwTitle').textContent = 'Top performers \u00b7 ' + sh.name;
        $('lwHours').textContent = sh.hours;
        $('lwInto').textContent = sh.into;
        $('lwOver').textContent = v.overline(data);
        Array.prototype.forEach.call($('lwTabs').children, function (b, i) { b.classList.toggle('on', i === view); });

        const rows = data && data.stats ? (data.stats[v.key] || []) : null;
        let html = '';
        if (!rows) {
            html = '<div class="lw-empty">' + esc(lastError || 'Loading\u2026') + '</div>';
        } else if (!rows.length) {
            const msg = v.key === 'alarms' ? 'No alarms handled yet this shift'
                : (data.through ? 'Not enough finished work yet to compare'
                                : 'Available after the first full hour of the shift');
            html = '<div class="lw-empty">' + msg + '</div>';
        } else {
            // Podium order: 2nd, 1st, 3rd.
            [[1, 'p2', '2nd'], [0, 'p1', '1st'], [2, 'p3', '3rd']].forEach(function (p) {
                const r = rows[p[0]];
                if (!r) { html += '<div></div>'; return; }
                html += '<div class="lw-card ' + p[1] + '"><div class="lw-place">' + p[2] + '</div><div>' +
                        '<div class="lw-name">' + esc(r.name) + '</div>' +
                        '<div class="lw-value">' + esc(r.value) + '</div>' +
                        '<div class="lw-note">' + esc(r.note) + '</div></div></div>';
            });
        }
        $('lwPodium').innerHTML = html;

        const stale = lastOk && Date.now() - lastOk > 3 * POLL_MS;
        $('lwFootR').innerHTML = data
            ? (stale ? '<span class="lw-warn">not updated since ' + new Date(lastOk).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '</span>'
                     : esc(data.online) + ' online')
            : '';
    }

    // Progress bar and rotation.
    setInterval(function () {
        const e = Date.now() - viewStarted;
        if (e >= ROTATE_MS) { view = (view + 1) % VIEWS.length; viewStarted = Date.now(); render(); }
        $('lwProg').style.width = Math.min(100, (e / ROTATE_MS) * 100) + '%';
    }, 250);
    // Keeps the "into shift" clock and the shift name current between fetches.
    setInterval(render, 30 * 1000);

    /* ------------------------------------------------------------------ fetching */

    function base() {
        const saved = GM_getValue('lwBase', null);
        return BASES.indexOf(saved) !== -1 ? saved : BASES[0];
    }

    function load(b, retry) {
        b = b || base();
        if (retry === undefined) retry = true;
        const unreachable = function () {
            const i = BASES.indexOf(b), next = BASES[(i + 1) % BASES.length];
            if (retry && next !== b) { load(next, false); return; }
            lastError = 'Leaderboard unavailable: the Worker could not be reached.';
            console.error('[Livewall] ' + lastError);
            render();
        };
        GM_xmlhttpRequest({
            method: 'GET',
            url: b + '/api/leaderboard?tz=' + new Date().getTimezoneOffset(),
            headers: { 'X-Api-Key': LEADERBOARD_KEY },
            timeout: 20000,
            onload: function (r) {
                GM_setValue('lwBase', b);
                if (r.status === 401) {
                    lastError = 'Leaderboard key refused. Check LEADERBOARD_KEY in this script.';
                    console.error('[Livewall] ' + lastError);
                } else if (r.status !== 200) {
                    lastError = 'Leaderboard unavailable (status ' + r.status + ').';
                    console.error('[Livewall] ' + lastError, r.responseText);
                } else {
                    try {
                        data = JSON.parse(r.responseText);
                        lastOk = Date.now();
                        lastError = '';
                    } catch (e) {
                        lastError = 'Leaderboard sent something unreadable.';
                        console.error('[Livewall] ' + lastError, e);
                    }
                }
                render();
            },
            onerror: unreachable,
            ontimeout: unreachable
        });
    }

    render();
    load();
    setInterval(load, POLL_MS);
    console.log('[Livewall] leaderboard ' + '1.0.0' + ' running; refreshing every ' + (POLL_MS / 60000) + ' minutes.');
})();
