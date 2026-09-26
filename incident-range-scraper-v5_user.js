// ==UserScript==
// @name         Incident Range Counter + QA Logger (v5)
// @namespace    incident-range-scraper
// @version      5.0
// @description  On the admin site: count incidents in a date/time range. On incidentcode.com: log QA notes per incident (issue type, agent, notes, auto-captured site label) with local persistence, CSV export, and copy-all-to-clipboard for pasting into Excel.
// @match        https://admin.policepriority.com/*
// @match        https://incidentcode.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // =========================================================================
  // SHARED HELPERS
  // =========================================================================

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function makeDraggable(panel, handle) {
    let dragging = false, offX = 0, offY = 0;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      offX = e.clientX - panel.offsetLeft;
      offY = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = `${e.clientX - offX}px`;
      panel.style.top = `${e.clientY - offY}px`;
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function basePanelStyle() {
    return `
      position: fixed; top: 80px; right: 20px; z-index: 999999;
      background: #fff; border: 1px solid #ccc; border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2); padding: 14px; width: 300px;
      font-family: -apple-system, Segoe UI, Arial, sans-serif; font-size: 13px; color: #222;
      max-height: 90vh; overflow-y: auto;
    `;
  }

  // Tab-separated text pastes into Excel/Sheets as proper columns (unlike CSV,
  // which just pastes as one column of quoted text when copied via clipboard).
  // includeHeaders defaults to true; pass false when pasting into a sheet that
  // already has its own header row (e.g. row 1 in the QA log), so repeated
  // copy/pastes don't dump a duplicate "url / siteLabel / ..." row each time.
  function toTSV(headers, rows, includeHeaders = true) {
    const clean = (v) => String(v || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
    const lines = includeHeaders ? [headers.join('\t')] : [];
    for (const r of rows) {
      lines.push(headers.map((h) => clean(r[h])).join('\t'));
    }
    return lines.join('\n');
  }

  function downloadCSV(filenamePrefix, headers, rows) {
    const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push(headers.map((h) => esc(r[h])).join(','));
    }
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenamePrefix}-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // PANEL 1: ADMIN SITE — Incident Range Counter
  // =========================================================================

  function buildCounterPanel() {
    let running = false;
    let stopRequested = false;

    const POLL_INTERVAL_MS = 300;
    const PAGE_LOAD_TIMEOUT_MS = 12000;
    const SETTLE_DELAY_MS = 250;
    const MAX_PAGES = 2000;

    // Rows must have BOTH a <time datetime=""> AND a "Public Link" cell.
    // This excludes the "Last 25 Incident Views" side panel, which has <time>
    // elements too (relative "x minutes ago") but no Public Link.
    function getRows() {
      const rows = Array.from(document.querySelectorAll('tr'));
      return rows.filter((tr) => {
        const hasTime = tr.querySelector('td time[datetime]');
        if (!hasTime) return false;
        return Array.from(tr.querySelectorAll('td a')).some(
          (a) => a.textContent.trim() === 'Public Link'
        );
      });
    }

    function getRowIsoTime(tr) {
      const timeEl = tr.querySelector('td time[datetime]');
      return timeEl ? timeEl.getAttribute('datetime') : '';
    }

    function getRowId(tr) {
      const tds = tr.querySelectorAll('td');
      return tds[0] ? tds[0].textContent.trim() : '';
    }

    function findNextButton() {
      const candidates = Array.from(document.querySelectorAll('button, a, span[role="button"]'));
      return candidates.find((el) => {
        const txt = (el.textContent || '').trim().toLowerCase();
        return txt === 'next' && !el.disabled && el.offsetParent !== null;
      }) || null;
    }

    function firstRowSignature() {
      const rows = getRows();
      return rows.length ? getRowId(rows[0]) : null;
    }

    async function clickNextAndWait() {
      const beforeSig = firstRowSignature();
      const nextBtn = findNextButton();
      if (!nextBtn) throw new Error('Could not find a "Next" button on the page.');
      nextBtn.click();

      const start = Date.now();
      while (Date.now() - start < PAGE_LOAD_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);
        const afterSig = firstRowSignature();
        if (afterSig !== null && afterSig !== beforeSig) {
          await sleep(SETTLE_DELAY_MS);
          return true;
        }
      }
      return false;
    }

    function parseLocalDatetime(value) {
      if (!value) return null;
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d;
    }

    function updateStatus(msg) {
      const el = document.getElementById('irs-status');
      if (el) el.textContent = msg;
    }

    function updateCount(n) {
      const el = document.getElementById('irs-count');
      if (el) el.textContent = `${n} incidents in range`;
    }

    async function runCount(newestBound, oldestBound) {
      running = true;
      stopRequested = false;
      let total = 0;
      updateCount(total);

      let pageCount = 0;

      while (pageCount < MAX_PAGES) {
        if (stopRequested) {
          updateStatus('Stopped by user.');
          break;
        }

        const rows = getRows();
        if (!rows.length) {
          updateStatus('No rows found on page — check selectors.');
          break;
        }

        let hitOldestBound = false;

        for (const tr of rows) {
          const iso = getRowIsoTime(tr);
          if (!iso) continue;
          const rowDate = new Date(iso);

          if (newestBound && rowDate > newestBound) continue; // too new, skip
          if (oldestBound && rowDate < oldestBound) { // too old, and everything after is too
            hitOldestBound = true;
            break;
          }
          total += 1;
        }

        updateCount(total);

        if (hitOldestBound) {
          updateStatus(`Done — reached the oldest bound. Total: ${total}`);
          break;
        }

        pageCount += 1;
        updateStatus(`Scanned page ${pageCount}, ${total} so far. Clicking Next...`);

        const advanced = await clickNextAndWait();
        if (!advanced) {
          updateStatus(`Stopped: "Next" did not load a new page (may be the last page). Total: ${total}`);
          break;
        }
      }

      if (pageCount >= MAX_PAGES) {
        updateStatus(`Stopped: hit safety cap of ${MAX_PAGES} pages. Total: ${total}`);
      }

      running = false;
    }

    const panel = document.createElement('div');
    panel.id = 'irs-panel';
    panel.style.cssText = basePanelStyle();
    panel.innerHTML = `
      <div style="font-weight:600; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; cursor:move;" id="irs-drag-handle">
        <span>Incident Range Counter</span>
        <span id="irs-close" style="cursor:pointer; font-weight:normal;">&times;</span>
      </div>
      <label style="display:block; margin-bottom:4px;">Newest (top of range)</label>
      <input type="datetime-local" id="irs-newest" style="width:100%; margin-bottom:8px; box-sizing:border-box;">
      <label style="display:block; margin-bottom:4px;">Oldest (bottom of range)</label>
      <input type="datetime-local" id="irs-oldest" style="width:100%; margin-bottom:10px; box-sizing:border-box;">
      <div style="display:flex; gap:6px; margin-bottom:10px;">
        <button id="irs-start" style="flex:1; padding:6px; cursor:pointer;">Start</button>
        <button id="irs-stop" style="flex:1; padding:6px; cursor:pointer;">Stop</button>
      </div>
      <div id="irs-count" style="font-weight:600; margin-bottom:4px;">0 incidents in range</div>
      <div id="irs-status" style="color:#555; min-height: 2.4em;">Idle.</div>
    `;
    document.body.appendChild(panel);

    document.getElementById('irs-close').onclick = () => panel.remove();

    document.getElementById('irs-start').onclick = () => {
      if (running) {
        alert('Already running.');
        return;
      }
      const newestVal = document.getElementById('irs-newest').value;
      const oldestVal = document.getElementById('irs-oldest').value;
      const newestBound = parseLocalDatetime(newestVal);
      const oldestBound = parseLocalDatetime(oldestVal);
      if (!oldestBound) {
        alert('Please set at least the "Oldest" bound so the script knows when to stop.');
        return;
      }
      runCount(newestBound, oldestBound);
    };

    document.getElementById('irs-stop').onclick = () => {
      stopRequested = true;
    };

    makeDraggable(panel, document.getElementById('irs-drag-handle'));
  }

  // =========================================================================
  // PANEL 2: incidentcode.com — QA Logger
  // =========================================================================

  // Bumped to v2 because entries now carry a siteLabel field. Old v1 data
  // is left untouched under its old key rather than migrated/mixed in.
  const QA_STORAGE_KEY = 'irs_qa_entries_v2';

  // Matches the site/location label shown under the map, e.g.
  // "7 - Eleven - 40841 [656-15147]" — a name/number followed by a
  // bracketed code. Heuristic since we don't have a stable CSS hook for it.
  const SITE_LABEL_PATTERN = /\[[^\[\]]{2,20}\]\s*$/;

  function scrapeSiteLabel() {
    const candidates = document.querySelectorAll('h1, h2, h3, h4, strong, b, div, span, p');
    for (const el of candidates) {
      // Skip elements with element children — we want a text-only leaf,
      // otherwise we'd match giant wrapper divs that contain the map too.
      if (el.children.length > 0) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 120) continue;
      if (SITE_LABEL_PATTERN.test(text)) {
        return text;
      }
    }
    return '';
  }

  function loadQAEntries() {
    try {
      const raw = localStorage.getItem(QA_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveQAEntries(entries) {
    localStorage.setItem(QA_STORAGE_KEY, JSON.stringify(entries));
  }

  function buildQAPanel() {
    let entries = loadQAEntries();

    const panel = document.createElement('div');
    panel.id = 'qa-panel';
    panel.style.cssText = basePanelStyle();
    panel.innerHTML = `
      <div style="font-weight:600; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; cursor:move;" id="qa-drag-handle">
        <span>Incident QA Logger</span>
        <span id="qa-close" style="cursor:pointer; font-weight:normal;">&times;</span>
      </div>

      <label style="display:block; margin-bottom:4px;">Incident Code Link</label>
      <div style="display:flex; gap:6px; margin-bottom:10px;">
        <input type="text" id="qa-url" readonly style="flex:1; min-width:0; box-sizing:border-box; background:#f5f5f5;">
        <button id="qa-recapture" title="Re-capture URL + site label from page" style="padding:4px 8px; cursor:pointer;">↻</button>
      </div>

      <label style="display:block; margin-bottom:4px;">Site Label (auto-captured)</label>
      <input type="text" id="qa-site-label" style="width:100%; margin-bottom:10px; box-sizing:border-box; background:#f5f5f5;" placeholder="Edit here if auto-capture missed it">


      <label style="display:block; margin-bottom:4px;">What was incorrect?</label>
      <div style="margin-bottom:10px;">
        <label style="display:block; margin-bottom:2px;"><input type="radio" name="qa-issue" value="No Comment/Incomplete"> No Comment / Incomplete</label>
        <label style="display:block; margin-bottom:2px;"><input type="radio" name="qa-issue" value="No Picture"> No Picture</label>
        <label style="display:block;"><input type="radio" name="qa-issue" value="Both"> Both</label>
      </div>

      <label style="display:block; margin-bottom:4px;">Agent's Name</label>
      <input type="text" id="qa-agent" style="width:100%; margin-bottom:10px; box-sizing:border-box;">

      <label style="display:block; margin-bottom:4px;">Any Notes</label>
      <textarea id="qa-notes" rows="3" style="width:100%; margin-bottom:10px; box-sizing:border-box; resize:vertical;"></textarea>

      <button id="qa-save" style="width:100%; padding:7px; cursor:pointer; margin-bottom:10px;">Save Entry</button>

      <div id="qa-count" style="font-weight:600; margin-bottom:8px;">0 entries saved</div>
      <button id="qa-copy" style="width:100%; padding:7px; cursor:pointer; margin-bottom:6px;">Copy All (for Excel)</button>
      <div style="display:flex; gap:6px;">
        <button id="qa-csv" style="flex:1; padding:6px; cursor:pointer;">Download CSV</button>
        <button id="qa-clear" style="flex:1; padding:6px; cursor:pointer;">Clear All</button>
      </div>
    `;
    document.body.appendChild(panel);

    const urlField = document.getElementById('qa-url');
    const siteLabelField = document.getElementById('qa-site-label');

    function captureUrl() {
      urlField.value = window.location.href;
      // Auto-fill only when empty or still showing a previous auto-capture,
      // so we don't stomp on a manual correction the user just typed.
      const scraped = scrapeSiteLabel();
      if (scraped && !siteLabelField.dataset.manuallyEdited) {
        siteLabelField.value = scraped;
      }
    }
    captureUrl();

    // Hash-based nav within the SPA doesn't reload the page, so re-capture on hash changes too.
    window.addEventListener('hashchange', captureUrl);

    // If the user edits the site label by hand, stop auto-overwriting it
    // until they hit ↻ again (which resets the flag and re-scrapes fresh).
    siteLabelField.addEventListener('input', () => {
      siteLabelField.dataset.manuallyEdited = '1';
    });

    function updateCount() {
      document.getElementById('qa-count').textContent = `${entries.length} entries saved`;
    }
    updateCount();

    document.getElementById('qa-close').onclick = () => panel.remove();
    document.getElementById('qa-recapture').onclick = () => {
      delete siteLabelField.dataset.manuallyEdited;
      captureUrl();
    };

    document.getElementById('qa-save').onclick = () => {
      const url = urlField.value.trim();
      const siteLabel = siteLabelField.value.trim();
      const issueRadio = document.querySelector('input[name="qa-issue"]:checked');
      const issue = issueRadio ? issueRadio.value : '';
      const agent = document.getElementById('qa-agent').value.trim();
      const notes = document.getElementById('qa-notes').value.trim();

      if (!url) {
        alert('No incident URL captured — click the ↻ button to re-capture it.');
        return;
      }

      entries.push({
        url,
        siteLabel,
        issue,
        agent,
        notes,
        savedAt: new Date().toISOString(),
      });
      saveQAEntries(entries);
      updateCount();

      // Clear issue + notes for the next entry, keep Agent's Name for convenience.
      if (issueRadio) issueRadio.checked = false;
      document.getElementById('qa-notes').value = '';
      // Reset so the next incident's label gets freshly auto-captured.
      delete siteLabelField.dataset.manuallyEdited;
    };

    document.getElementById('qa-copy').onclick = () => {
      if (!entries.length) {
        alert('No entries saved yet.');
        return;
      }
      const headers = ['url', 'siteLabel', 'issue', 'agent', 'notes', 'savedAt'];
      // No header row here — it pastes straight under row 1, which already
      // has the column labels, so nobody has to delete a duplicate header.
      const tsv = toTSV(headers, entries, false);
      navigator.clipboard.writeText(tsv)
        .then(() => alert(`Copied ${entries.length} entries — paste directly into Excel/Sheets.`))
        .catch(() => alert('Copy failed — see console for the data.') || console.log(tsv));
    };

    document.getElementById('qa-csv').onclick = () => {
      if (!entries.length) {
        alert('No entries saved yet.');
        return;
      }
      downloadCSV('incident-qa-log-v5', ['url', 'siteLabel', 'issue', 'agent', 'notes', 'savedAt'], entries);
    };

    document.getElementById('qa-clear').onclick = () => {
      if (!entries.length) return;
      if (!confirm(`Delete all ${entries.length} saved QA entries? This cannot be undone.`)) return;
      entries = [];
      saveQAEntries(entries);
      updateCount();
    };

    makeDraggable(panel, document.getElementById('qa-drag-handle'));
  }

  // =========================================================================
  // ENTRY POINT
  // =========================================================================

  const host = window.location.hostname;
  if (host.includes('policepriority.com')) {
    buildCounterPanel();
  } else if (host.includes('incidentcode.com')) {
    buildQAPanel();
  }
})();
