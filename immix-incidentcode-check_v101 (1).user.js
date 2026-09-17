// ==UserScript==
// @name         Immix - IncidentCode Close Check
// @namespace    immix-incidentcode-check
// @version      1.1
// @description  Warns before closing an event if an IncidentCode was created but media AND a comment were not both attached to it
// @match        https://newapp.smartviewplus.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const CREATE_TEXT  = 'Creating new IncidentCode for location';
    const MEDIA_TEXT   = 'Adding media to existing IncidentCode';
    // "Adding comment 'whatever the user typed' to existing IncidentCode"
    const COMMENT_REGEX = /Adding comment\s+'.*?'\s+to existing IncidentCode/i;

    // Normalize whitespace/tabs so matching is reliable regardless of table formatting
    function normalize(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    function getEventsLogText() {
        const container = document.getElementById('currentEventsTable')
            || document.getElementById('tabs-current-events');
        if (!container) return '';
        return normalize(container.innerText || container.textContent);
    }

    function incidentCodeCreatedWithoutFollowUp(logText) {
        const created = logText.includes(CREATE_TEXT);
        if (!created) return false;
        const hasMedia = logText.includes(MEDIA_TEXT);
        const hasComment = COMMENT_REGEX.test(logText);
        // Popup unless BOTH media and a comment were added
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
