// ==UserScript==
// @name         Mapfinder
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Adds a button under SiteAddress that opens Google Maps and a non-emergency police number search
// @author       SOC Scripts
// @match        https://newapp.smartviewplus.com/*
// @include      /^https?://.*SiteDetails.*$/
// @run-at       document-idle
// @grant        GM_openInTab
// @downloadURL  https://raw.githubusercontent.com/socscripts/soc-scripts/main/Mapfinderv1.user.js
// @updateURL    https://raw.githubusercontent.com/socscripts/soc-scripts/main/Mapfinderv1.user.js
// ==/UserScript==

(function () {
    'use strict';

    const BTN_ID = 'btnSearchPD';

    // Open a tab. Prefers GM_openInTab (not blocked by the popup blocker),
    // falls back to window.open if the grant is unavailable.
    function openTab(url, active) {
        if (typeof GM_openInTab === 'function') {
            GM_openInTab(url, { active: active, insert: true, setParent: true });
        } else {
            window.open(url, '_blank', 'noopener');
        }
    }

    function cleanAddress(el) {
        // innerText already collapses <br> into line breaks, so no HTML parsing needed
        return (el.innerText || el.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function buildButton(addressEl) {
        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.type = 'button';
        btn.textContent = '🗺️ Open Map & 👮 Police Search';

        Object.assign(btn.style, {
            display: 'inline-block',
            marginTop: '6px',
            padding: '5px 12px',
            cursor: 'pointer',
            backgroundColor: '#004080',
            color: '#ffffff',
            border: '1px solid #002b55',
            borderRadius: '8px',
            fontWeight: 'bold',
            fontSize: '12px',
            boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.4)'
        });

        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();

            const address = cleanAddress(addressEl);
            if (!address) {
                alert('Mapfinder: no address text found in #SiteAddress.');
                return;
            }

            const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' +
                encodeURIComponent(address);
            const pdUrl = 'https://www.google.com/search?q=' +
                encodeURIComponent(address + ' non emergency police number');

            openTab(mapsUrl, false);
            openTab(pdUrl, true);
        });

        return btn;
    }

    function inject() {
        const addressEl = document.getElementById('SiteAddress');
        if (!addressEl) return false;
        if (document.getElementById(BTN_ID)) return true;

        const wrap = document.createElement('div');
        wrap.appendChild(buildButton(addressEl));
        addressEl.insertAdjacentElement('afterend', wrap);
        return true;
    }

    // The site details panel is rendered dynamically, so document-idle alone
    // is not enough — watch for the element appearing (and re-appearing).
    inject();

    const observer = new MutationObserver(function () {
        inject();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
})();
