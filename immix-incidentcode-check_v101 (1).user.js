// ==UserScript==
// @name         Immix - IncidentCode Close Check
// @namespace    immix-incidentcode-check
// @version      1.2
// @description  Warns before closing an event if an IncidentCode was created but media AND a comment were not both attached to it
// @match        https://newapp.smartviewplus.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Set to true, then open the browser console (F12) and click Close Event.
    // It will print the exact text being searched and which checks passed.
    const DEBUG = true;

    // "Incident Code" / "IncidentCode" / "incidentcode" all accepted
    const IC = String.raw`Incident\s*Code`;

    const CREATE_REGEX = new RegExp(String.raw`Creating new ${IC}\s+for location`, 'i');
    const MEDIA_REGEX  = new RegExp(String.raw`Adding media to existing ${IC}`, 'i');

    // Accepts straight quotes, curly quotes, double quotes, or no quotes at all,
    // and tolerates up to 500 chars of user-typed comment in between.
    const COMMENT_REGEX = new RegExp(
        String.raw`Adding comment\s*["'\u2018\u2019\u201C\u201D]?[\s\S]{0,500}?["'\u2018\u2019\u201C\u201D]?\s*to existing ${IC}`,
        'i'
    );

    // Fallback: the phrase appears at all, even if the tail is truncated in the table
    const COMMENT_LOOSE_REGEX = /Adding comment\b/i;

    // Normalize whitespace, tabs, NBSP, and smart quotes so matching is reliable
    function normalize(text) {
        return (text || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function getEventsLogText() {
        const ids = ['currentEventsTable', 'tabs-current-events'];
        let combined = '';

        for (const id of ids) {
            const el = document.getElementById(id);
            if (el) combined += ' ' + (el.innerText || el.textContent || '');
        }

        // If the known containers gave us nothing useful, fall back to the whole page.
        // The log rows are somewhere in the DOM even if the IDs changed.
        if (!/Incident\s*Code/i.test(combined)) {
            combined += ' ' + (document.body.innerText || document.body.textContent || '');
        }

        return normalize(combined);
    }

    function incidentCodeCreatedWithoutFollowUp(logText) {
        const created    = CREATE_REGEX.test(logText);
        const hasMedia   = MEDIA_REGEX.test(logText);
        const hasComment = COMMENT_REGEX.test(logText) || COMMENT_LOOSE_REGEX.test(logText);

        if (DEBUG) {
            console.log('[IC-Check] created:', created,
                        '| media:', hasMedia,
                        '| comment(strict):', COMMENT_REGEX.test(logText),
                        '| comment(loose):', COMMENT_LOOSE_REGEX.test(logText));
            // Print just the relevant lines so the console isn't flooded
            const hits = logText.match(/(Creating new|Adding media|Adding comment)[\s\S]{0,160}/gi);
            console.log('[IC-Check] matched log fragments:', hits);
            if (!hits) console.log('[IC-Check] FULL scraped text:', logText);
        }

        if (!created) return false;
        return !(hasMedia && hasComment);
    }

    function showConfirmModal(onContinue) {
        const overlay = document.createElement('div');
        overlay.id = 'tm-incidentcode-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', zIndex: 2147483647,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const box = document.createElement('div');
        Object.assign(box.style, {
            background: '#fff', color: '#000', padding: '20px 24px', borderRadius: '6px',
            maxWidth: '380px', textAlign: 'center', fontFamily: 'Arial, sans-serif',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)'
        });

        box.innerHTML = `
            <p style="font-size:15px; line-height:1.4; margin: 0 0 16px 0;">
                No media and/or comment was found for the IncidentCode created on this event.
                <br><br>
                Do you want to continue closing the event?
            </p>
        `;

        const btnContinue = document.createElement('button');
        btnContinue.textContent = 'Continue';
        Object.assign(btnContinue.style, {
            marginRight: '10px', padding: '6px 18px', cursor: 'pointer',
            background: '#4caf50', color: '#fff', border: 'none', borderRadius: '4px'
        });

        const btnCancel = document.createElement('button');
        btnCancel.textContent = 'Cancel';
        Object.assign(btnCancel.style, {
            padding: '6px 18px', cursor: 'pointer',
            background: '#ccc', color: '#000', border: 'none', borderRadius: '4px'
        });

        btnContinue.addEventListener('click', () => {
            overlay.remove();
            onContinue();
        });
        btnCancel.addEventListener('click', () => overlay.remove());

        box.appendChild(btnContinue);
        box.appendChild(btnCancel);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }

    function triggerRealClose() {
        if (window.currentEvent && typeof window.currentEvent.checkPendingAnalytics === 'function') {
            window.currentEvent.checkPendingAnalytics();
        }
    }

    // Capture phase on document runs BEFORE the button's own inline onclick fires,
    // so we can intercept and stop it there.
    document.addEventListener('click', function (e) {
        const target = e.target.closest && e.target.closest('#btnCloseEvent');
        if (!target) return;

        const logText = getEventsLogText();
        if (incidentCodeCreatedWithoutFollowUp(logText)) {
            e.preventDefault();
            e.stopPropagation();
            showConfirmModal(triggerRealClose);
        }
        // Otherwise, let the click proceed normally (no interference).
    }, true);

})();
