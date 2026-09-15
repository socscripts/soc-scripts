// ==UserScript==
// @name         Auto Open Details
// @namespace    http://tampermonkey.net/
// @version      2.0
// @match        https://newapp.smartviewplus.com/SiteMonitor.aspx*
// @grant        none
// @description  Auto-opens the Details panel once the event has fully loaded
// @author       Albert D. Delgado
// ==/UserScript==

(function () {
    'use strict';

    var MAX_ATTEMPTS = 30;   // 30 x 1s = 30 seconds before giving up
    var attempts = 0;

    function tryOpenDetails() {
        attempts++;

        // showDetails() needs both the site data AND the current event
        // record loaded - checking currentEvent is what was missing before.
        var ready =
            typeof window.showDetails === 'function' &&
            window.currentEvent &&
            window.site;

        if (ready) {
            window.showDetails();
            return true;
        }

        if (attempts >= MAX_ATTEMPTS) {
            console.warn('[Auto Open Details] Gave up after ' + MAX_ATTEMPTS + ' seconds - site/currentEvent never became ready.');
            return true; // stop polling either way
        }

        return false;
    }

    var timer = setInterval(function () {
        if (tryOpenDetails()) {
            clearInterval(timer);
        }
    }, 1000);
})();
