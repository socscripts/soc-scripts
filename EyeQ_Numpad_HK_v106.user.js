// ==UserScript==
// @name         EyeQ Numpad Hotkeys
// @namespace    http://tampermonkey.net/
// @version      1.0.6
// @description  Use the numpad to copy selected text into slots and paste it back anywhere. Shift/Ctrl/Alt each unlock their own bank of 10 slots (40 total). Floating panel auto-shows on every site, can be minimized, and the minimize button can optionally disable the script instead.
// @author       You
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/* ---------------------------------------------------------
   v106 CHANGE NOTES
   1. The panel's minimize button (—) can now be switched, in
      Settings, to disable the script instead of collapsing the
      panel. Pick "Minimize the panel" (default, same as before)
      or "Disable the script" — a toggle that turns hotkeys
      off/on with a single click of the same button, without
      opening the Settings panel. The button's icon and color
      reflect which mode is active and, in disable mode, whether
      hotkeys are currently on or off.
--------------------------------------------------------- */

/* ---------------------------------------------------------
   v102 CHANGE NOTES
   1. Floating panel now auto-opens on EVERY page load instead
      of relying on a saved "open" flag (that flag lived in
      shared GM storage, so closing it on one site silently
      closed it everywhere until you re-opened it from the
      Tampermonkey menu). Position + minimized-state are still
      remembered; visibility is not.
   2. Added a minimize button (—) that collapses the panel to
      a small round floating badge. Click the badge to expand.
   3. Windows has a known quirk: holding Shift while pressing a
      numpad digit (with NumLock on) can make the OS report a
      navigation key (Home/End/Arrow/PageUp/PageDown/Insert)
      instead of the NumpadX code, before the page ever sees it.
      That's why physical "Shift + Numpad1" could fail while the
      on-screen "1" button (which doesn't go through the
      keyboard at all) always worked. Added an OPT-IN workaround
      (off by default, toggle in Settings) that also recognizes
      those navigation keys as numpad digits when Shift is held.
      It's opt-in because, while enabled, it overrides normal
      Shift+Home/End/Arrow text-selection behavior everywhere.
   4. Unified panel section borders/radii/gaps so all edges match.
--------------------------------------------------------- */

(function () {
    'use strict';

    /* ---------------------------------------------------------
       DEFAULTS
    --------------------------------------------------------- */
    const NUMPAD_KEYS = {
        Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4',
        Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9'
    };

    const LOGO_DATA_URI = 'data:image/png;base64,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';

    const DEFAULT_SETTINGS = {
        enabled: true,
        // Opt-in workaround for the Windows "Shift+Numpad becomes a
        // navigation key" quirk. Off by default because, while on, it
        // makes Shift+Home/End/Arrow/PageUp/PageDown/Insert act as our
        // numpad hotkeys everywhere on the page (not just inside our
        // panel), which overrides normal text-selection behavior for
        // those combos. See v102 change notes at the top of the file.
        shiftNumpadWorkaround: false,
        // What the floating panel's minimize (—) button does when clicked:
        // 'minimize' (default) collapses the panel to the small round badge;
        // 'disable' instead toggles the whole script on/off (settings.enabled),
        // leaving the panel expanded. See v106 change notes.
        minimizeAction: 'minimize'
    };

    // Windows can deliver these codes instead of NumpadX when Shift is
    // held and NumLock is on (numpad's "navigation" layer leaking
    // through even though NumLock never actually turned off). Only
    // consulted when shiftNumpadWorkaround is enabled.
    const SHIFT_NUMPAD_NAV_FALLBACK = {
        Insert: '0', End: '1', ArrowDown: '2', PageDown: '3',
        ArrowLeft: '4', Clear: '5', ArrowRight: '6',
        Home: '7', ArrowUp: '8', PageUp: '9'
    };

    /* ---------------------------------------------------------
       BANKS
       Each bank has its own 10 slots (Numpad 0-9). Which bank you
       hit is decided by which modifier(s) you hold:

         PASTE (single modifier + Numpad#):
           no modifier -> Bank 1 (Plain)
           Shift        -> Bank 2 (Shift)
           Ctrl         -> Bank 3 (Ctrl)
           Alt          -> Bank 4 (Alt)

         COPY (a two/three-modifier combo + Numpad#, so it never
         collides with the paste combos above):
           Ctrl+Shift       -> copy into Bank 1 (Plain)
           Shift+Alt        -> copy into Bank 2 (Shift)
           Ctrl+Alt         -> copy into Bank 3 (Ctrl)
           Ctrl+Shift+Alt   -> copy into Bank 4 (Alt)
    --------------------------------------------------------- */
    const BANK_DEFS = [
        { key: '0', label: 'Bank 1 · Plain', pasteMods: [], pasteLabel: 'No modifier', copyMods: ['ctrlKey', 'shiftKey'], copyLabel: 'Ctrl+Shift' },
        { key: '1', label: 'Bank 2 · Shift', pasteMods: ['shiftKey'], pasteLabel: 'Shift', copyMods: ['shiftKey', 'altKey'], copyLabel: 'Shift+Alt' },
        { key: '2', label: 'Bank 3 · Ctrl', pasteMods: ['ctrlKey'], pasteLabel: 'Ctrl', copyMods: ['ctrlKey', 'altKey'], copyLabel: 'Ctrl+Alt' },
        { key: '3', label: 'Bank 4 · Alt', pasteMods: ['altKey'], pasteLabel: 'Alt', copyMods: ['ctrlKey', 'shiftKey', 'altKey'], copyLabel: 'Ctrl+Shift+Alt' },
    ];

    function bankByKey(key) {
        return BANK_DEFS.find(b => b.key === key);
    }

    // Prefill slots here. This only applies on first run before any
    // slots are saved — after that, edit them via the Settings panel instead.
    // Keyed by bank ("0"-"3"), then by numpad digit ("0"-"9").
    const DEFAULT_BANKS = {
        "0": {
            "0": "individual seen onsite during monitoring hours.",
            "1": "Issued PA.",
            "2": "individual did not leave, Dispatched PD.",
            "3": "Attempted to call contacts, but unable to reach.",
            "4": "Spoke to ____ staff onsite.",
            "5": "Spoke to ____ asked to dispatch",
            "6": "individual seen passing through",
            "7": "Group of individuals seen",
            "8": "Issued PA for precaution",
            "9": "No further actions taken",
        },
        "1": {},
        "2": {},
        "3": {},
    };

    /* ---------------------------------------------------------
       STORAGE HELPERS
    --------------------------------------------------------- */
    function getSettings() {
        return Object.assign({}, DEFAULT_SETTINGS, GM_getValue('npch_settings', {}));
    }
    function setSettings(s) {
        GM_setValue('npch_settings', s);
    }
    function getBanks() {
        const stored = GM_getValue('npch_banks', {});
        const merged = {};
        for (const bank of BANK_DEFS) {
            merged[bank.key] = Object.assign({}, DEFAULT_BANKS[bank.key] || {}, stored[bank.key] || {});
        }
        return merged;
    }
    function setBanks(banks) {
        GM_setValue('npch_banks', banks);
    }

    /* ---------------------------------------------------------
       TOAST NOTIFICATION (small feedback popup)
    --------------------------------------------------------- */
    let toastTimer = null;
    function toast(msg) {
        let el = document.getElementById('npch-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'npch-toast';
            el.style.cssText = `
                position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
                background: #222; color: #fff; padding: 10px 16px; border-radius: 8px;
                font: 13px/1.4 -apple-system, Segoe UI, sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.3);
                opacity: 0; transition: opacity .15s ease; pointer-events: none; max-width: 320px;
            `;
            document.body.appendChild(el);
        }
        el.textContent = msg;
        requestAnimationFrame(() => (el.style.opacity = '1'));
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (el.style.opacity = '0'), 1200);
    }

    /* ---------------------------------------------------------
       TRACK LAST FOCUSED EDITABLE FIELD
       (so clicking the floating panel's buttons can still paste
       into the field you were just typing in)
    --------------------------------------------------------- */
    let lastActiveElement = null;

    function isEditable(el) {
        if (!el) return false;
        if (el.tagName === 'TEXTAREA') return true;
        if (el.tagName === 'INPUT' && /^(text|search|url|tel|email|password)$/i.test(el.type)) return true;
        if (el.isContentEditable) return true;
        return false;
    }

    document.addEventListener('focusin', (e) => {
        if (floatingPanelEl && floatingPanelEl.contains(e.target)) return;
        if (isEditable(e.target)) lastActiveElement = e.target;
    });

    /* ---------------------------------------------------------
       COPY / PASTE LOGIC
    --------------------------------------------------------- */
    function getSelectedText() {
        const active = document.activeElement;
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
            const start = active.selectionStart, end = active.selectionEnd;
            if (start !== end) return active.value.substring(start, end);
        }
        const sel = window.getSelection().toString();
        return sel;
    }

    function copyToSlot(bankKey, slotKey) {
        const bank = bankByKey(bankKey);
        const text = getSelectedText();
        if (!text) {
            toast(`${bank.label} slot ${slotKey}: nothing selected`);
            return;
        }
        const banks = getBanks();
        banks[bankKey][slotKey] = text;
        setBanks(banks);
        toast(`Copied to ${bank.label} slot ${slotKey}: "${truncate(text)}"`);
    }

    function pasteFromSlot(bankKey, slotKey, targetEl) {
        const bank = bankByKey(bankKey);
        const banks = getBanks();
        const text = banks[bankKey][slotKey];
        if (!text) {
            toast(`${bank.label} slot ${slotKey} is empty`);
            return;
        }
        insertTextAtCursor(text, targetEl);
        toast(`Pasted ${bank.label} slot ${slotKey}`);
    }

    function truncate(str, n = 40) {
        return str.length > n ? str.slice(0, n) + '…' : str;
    }

    function insertTextAtCursor(text, targetEl) {
        // Prefer an explicit target, then whatever's focused, then the last
        // editable field the user was in before clicking the floating panel.
        let active = targetEl;
        if (!isEditable(active)) active = document.activeElement;
        if (!isEditable(active)) active = lastActiveElement;

        if (active && (active.tagName === 'TEXTAREA' ||
            (active.tagName === 'INPUT' && /^(text|search|url|tel|email|password)$/i.test(active.type)))) {
            active.focus();
            const start = active.selectionStart ?? active.value.length;
            const end = active.selectionEnd ?? active.value.length;
            const val = active.value;
            active.value = val.slice(0, start) + text + val.slice(end);
            const newPos = start + text.length;
            active.selectionStart = active.selectionEnd = newPos;
            active.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }
        if (active && active.isContentEditable) {
            active.focus();
            document.execCommand('insertText', false, text);
            return;
        }
        // Fallback: try clipboard write + let user paste manually
        navigator.clipboard?.writeText(text).then(() => {
            toast('Copied to system clipboard (no editable field focused)');
        }).catch(() => {
            toast('No editable field focused — could not paste');
        });
    }

    /* ---------------------------------------------------------
       KEY HANDLER
    --------------------------------------------------------- */
    function modsMatch(e, requiredMods) {
        // requiredMods must all be held, and no other modifier may be held
        // (so combos never accidentally fire on a bigger combo, and vice versa).
        const all = ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'];
        return all.every(m => (requiredMods.includes(m) ? e[m] : !e[m]));
    }

    function resolveSlotKey(e, settings) {
        if (e.code in NUMPAD_KEYS) return NUMPAD_KEYS[e.code];
        if (settings.shiftNumpadWorkaround && e.shiftKey && e.code in SHIFT_NUMPAD_NAV_FALLBACK) {
            return SHIFT_NUMPAD_NAV_FALLBACK[e.code];
        }
        return null;
    }

    document.addEventListener('keydown', function (e) {
        const settings = getSettings();
        if (!settings.enabled) return;
        const slotKey = resolveSlotKey(e, settings);
        if (slotKey === null) return;
        if (isSettingsPanelOpen() || isHotkeysPanelOpen()) return; // don't fire hotkeys while a popup is open
        if (floatingPanelEl && floatingPanelEl.contains(e.target)) return; // don't fire while typing in the floating panel itself

        // Copy combos are checked first since they require MORE modifiers
        // held than any paste combo, so there's no ambiguity either way.
        for (const bank of BANK_DEFS) {
            if (modsMatch(e, bank.copyMods)) {
                e.preventDefault();
                copyToSlot(bank.key, slotKey);
                return;
            }
        }
        for (const bank of BANK_DEFS) {
            if (modsMatch(e, bank.pasteMods)) {
                e.preventDefault();
                pasteFromSlot(bank.key, slotKey);
                return;
            }
        }
    }, true);

    /* ---------------------------------------------------------
       SETTINGS PANEL UI
    --------------------------------------------------------- */
    let panelEl = null;
    let settingsDraftBanks = null;
    let settingsActiveBank = '0';

    function isSettingsPanelOpen() {
        return !!panelEl;
    }

    function syncActiveBankInputsIntoDraft() {
        if (!panelEl || !settingsDraftBanks) return;
        const current = {};
        panelEl.querySelectorAll('[data-slot]').forEach(input => {
            const key = input.getAttribute('data-slot');
            if (input.value.trim() !== '') current[key] = input.value;
        });
        settingsDraftBanks[settingsActiveBank] = current;
    }

    function renderSettingsSlotRows() {
        const slots = settingsDraftBanks[settingsActiveBank] || {};
        let rows = '';
        for (let i = 0; i <= 9; i++) {
            const val = (slots[i] || '').replace(/"/g, '&quot;');
            rows += `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                    <span style="width:64px; font-weight:600; color:#555;">Numpad ${i}</span>
                    <input type="text" data-slot="${i}" value="${val}" placeholder="Sentence for slot ${i}"
                        style="flex:1; padding:6px 8px; border:1px solid #ccc; border-radius:6px; font-size:13px;">
                </div>`;
        }
        panelEl.querySelector('#npch-slots').innerHTML = rows;
    }

    function renderSettingsBankInfo() {
        const bank = bankByKey(settingsActiveBank);
        panelEl.querySelector('#npch-bank-hotkey-info').innerHTML =
            `Paste this bank: <strong>${bank.pasteLabel} + Numpad #</strong> &nbsp;·&nbsp; Copy into this bank: <strong>${bank.copyLabel} + Numpad #</strong>`;
        panelEl.querySelectorAll('.npch-bank-tab').forEach(btn => {
            const isSel = btn.getAttribute('data-bank') === settingsActiveBank;
            btn.style.background = isSel ? '#2563eb' : '#f5f5f5';
            btn.style.color = isSel ? '#fff' : '#333';
        });
    }

    function switchSettingsBank(bankKey) {
        syncActiveBankInputsIntoDraft();
        settingsActiveBank = bankKey;
        renderSettingsSlotRows();
        renderSettingsBankInfo();
    }

    function openSettingsPanel() {
        if (panelEl) return;
        const settings = getSettings();
        settingsDraftBanks = JSON.parse(JSON.stringify(getBanks()));
        settingsActiveBank = '0';

        const overlay = document.createElement('div');
        overlay.id = 'npch-overlay';
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483646;
            display: flex; align-items: center; justify-content: center;
            font: 13px/1.4 -apple-system, Segoe UI, sans-serif;
        `;

        const panel = document.createElement('div');
        panel.style.cssText = `
            background: #fff; color: #222; width: 520px; max-width: 92vw; max-height: 85vh;
            overflow-y: auto; border-radius: 10px; padding: 20px 22px; box-shadow: 0 10px 40px rgba(0,0,0,.3);
        `;

        const bankTabs = BANK_DEFS.map(b => `
            <button data-bank="${b.key}" class="npch-bank-tab" style="
                padding:6px 10px; border:none; border-radius:6px; cursor:pointer; font-size:12.5px; font-weight:600;">${b.label}</button>
        `).join('');

        panel.innerHTML = `
            <h2 style="margin:0 0 4px; font-size:16px;">Numpad Clipboard Hotkeys</h2>
            <p style="margin:0 0 16px; color:#666;">Copy selected text into a slot, then paste it anywhere with the numpad. Shift/Ctrl/Alt each unlock their own bank of 10 slots.</p>

            <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:16px;">
                <label style="display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" id="npch-enabled" ${settings.enabled ? 'checked' : ''}>
                    <span>Enabled</span>
                </label>
                <label style="display:flex; align-items:flex-start; gap:6px;">
                    <input type="checkbox" id="npch-shift-workaround" style="margin-top:3px;" ${settings.shiftNumpadWorkaround ? 'checked' : ''}>
                    <span>Fix Shift+Numpad on Windows (NumLock quirk workaround) — <span style="color:#888;">Windows sometimes reports Home/End/Arrow/PageUp/PageDown/Insert instead of the numpad digit when Shift is held. Turning this on also treats those keys as numpad digits while Shift is held, so Shift+Numpad hotkeys work reliably — but it also overrides normal Shift+Home/End/Arrow text-selection on the page.</span></span>
                </label>
                <div style="margin-top:6px; padding-top:10px; border-top:1px solid #eee;">
                    <span style="display:block; margin-bottom:6px; font-weight:600;">Panel minimize (—) button</span>
                    <label style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
                        <input type="radio" name="npch-minimize-action" id="npch-minimize-action-minimize" value="minimize" ${settings.minimizeAction !== 'disable' ? 'checked' : ''}>
                        <span>Minimize the panel (default)</span>
                    </label>
                    <label style="display:flex; align-items:flex-start; gap:6px;">
                        <input type="radio" name="npch-minimize-action" id="npch-minimize-action-disable" value="disable" style="margin-top:3px;" ${settings.minimizeAction === 'disable' ? 'checked' : ''}>
                        <span>Disable the script instead — <span style="color:#888;">clicking — turns hotkeys off/on with one click, instead of collapsing the panel.</span></span>
                    </label>
                </div>
            </div>

            <p style="margin:0 0 8px; font-weight:600;">Banks (each has its own 10 slots)</p>
            <div id="npch-bank-tabs" style="display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap;">${bankTabs}</div>
            <p id="npch-bank-hotkey-info" style="margin:0 0 12px; color:#555; font-size:12.5px; background:#f5f7fb; border-radius:6px; padding:8px 10px;"></p>

            <div id="npch-slots"></div>

            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:18px;">
                <button id="npch-cancel" style="padding:8px 14px; border-radius:6px; border:1px solid #ccc; background:#f5f5f5; cursor:pointer;">Cancel</button>
                <button id="npch-save" style="padding:8px 14px; border-radius:6px; border:none; background:#2563eb; color:#fff; cursor:pointer; font-weight:600;">Save</button>
            </div>
            <p style="margin-top:14px; color:#888; font-size:12px;">
                Tip: select text on the page, then hold the bank's copy combo + a numpad digit.
                Focus a text field and hold the bank's paste modifier (or nothing, for the Plain bank) + the same digit to insert it.
            </p>
        `;

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        panelEl = overlay;

        renderSettingsSlotRows();
        renderSettingsBankInfo();

        panel.querySelectorAll('.npch-bank-tab').forEach(btn => {
            btn.addEventListener('click', () => switchSettingsBank(btn.getAttribute('data-bank')));
        });

        panel.querySelector('#npch-cancel').addEventListener('click', closeSettingsPanel);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettingsPanel(); });

        panel.querySelector('#npch-save').addEventListener('click', () => {
            syncActiveBankInputsIntoDraft();
            const newSettings = {
                enabled: panel.querySelector('#npch-enabled').checked,
                shiftNumpadWorkaround: panel.querySelector('#npch-shift-workaround').checked,
                minimizeAction: panel.querySelector('input[name="npch-minimize-action"]:checked').value
            };
            setSettings(newSettings);
            setBanks(settingsDraftBanks);
            applyMinimizeButtonMode();
            if (newSettings.minimizeAction === 'disable' && !newSettings.enabled) {
                hideFloatingPanel();
            } else {
                showFloatingPanel();
            }
            toast('Settings saved');
            closeSettingsPanel();
        });
    }

    function closeSettingsPanel() {
        if (panelEl) {
            panelEl.remove();
            panelEl = null;
            settingsDraftBanks = null;
        }
    }

    GM_registerMenuCommand('⚙️ Numpad Hotkeys Settings', openSettingsPanel);

    // Also open settings with Ctrl+Alt+Numpad Decimal (.) as a quick shortcut
    document.addEventListener('keydown', function (e) {
        if (e.code === 'NumpadDecimal' && e.ctrlKey && e.altKey) {
            e.preventDefault();
            isSettingsPanelOpen() ? closeSettingsPanel() : openSettingsPanel();
        }
    }, true);

    /* ---------------------------------------------------------
       HOTKEYS CHEAT-SHEET POPUP (read-only quick reference)
    --------------------------------------------------------- */
    let hotkeysPanelEl = null;
    let hotkeysActiveBank = '0';

    function isHotkeysPanelOpen() {
        return !!hotkeysPanelEl;
    }

    function renderHotkeysSlotTable() {
        const banks = getBanks();
        const slots = banks[hotkeysActiveBank] || {};
        let rows = '';
        for (let i = 0; i <= 9; i++) {
            const preview = slots[i] ? truncate(slots[i], 34).replace(/</g, '&lt;') : '<span style="color:#aaa;">— empty —</span>';
            rows += `
                <tr>
                    <td style="padding:6px 8px; font-weight:600; white-space:nowrap;">Numpad ${i}</td>
                    <td style="padding:6px 8px; color:#555;">${preview}</td>
                </tr>`;
        }
        hotkeysPanelEl.querySelector('#npch-hk-slot-table tbody').innerHTML = rows;

        const bank = bankByKey(hotkeysActiveBank);
        hotkeysPanelEl.querySelector('#npch-hk-bank-info').innerHTML =
            `Paste: <strong>${bank.pasteLabel} + Numpad #</strong> &nbsp;·&nbsp; Copy: <strong>${bank.copyLabel} + Numpad #</strong>`;
        hotkeysPanelEl.querySelectorAll('.npch-hk-bank-tab').forEach(btn => {
            const isSel = btn.getAttribute('data-bank') === hotkeysActiveBank;
            btn.style.background = isSel ? '#2563eb' : '#f5f5f5';
            btn.style.color = isSel ? '#fff' : '#333';
        });
    }

    function openHotkeysPanel() {
        if (hotkeysPanelEl) return;
        closeSettingsPanel(); // don't stack panels

        const settings = getSettings();
        hotkeysActiveBank = '0';

        const overlay = document.createElement('div');
        overlay.id = 'npch-hotkeys-overlay';
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 2147483647;
            display: flex; align-items: center; justify-content: center;
            font: 13px/1.4 -apple-system, Segoe UI, sans-serif;
        `;

        const panel = document.createElement('div');
        panel.style.cssText = `
            background: #fff; color: #222; width: 440px; max-width: 92vw; max-height: 85vh;
            overflow-y: auto; border-radius: 10px; padding: 20px 22px; box-shadow: 0 10px 40px rgba(0,0,0,.3);
        `;

        const bankTabs = BANK_DEFS.map(b => `
            <button data-bank="${b.key}" class="npch-hk-bank-tab" style="
                padding:6px 10px; border:none; border-radius:6px; cursor:pointer; font-size:12.5px; font-weight:600;">${b.label}</button>
        `).join('');

        panel.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
                <h2 style="margin:0; font-size:16px;">Hotkeys Cheat Sheet</h2>
                <button id="npch-hk-close" style="border:none; background:none; font-size:18px; cursor:pointer; color:#888; line-height:1;">&times;</button>
            </div>
            <p style="margin:0 0 14px; color:#666;">
                Status: <strong style="color:${settings.enabled ? '#16a34a' : '#dc2626'};">${settings.enabled ? 'Enabled' : 'Disabled'}</strong>
            </p>

            <div id="npch-hk-bank-tabs" style="display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap;">${bankTabs}</div>
            <p id="npch-hk-bank-info" style="margin:0 0 14px; color:#555; font-size:12.5px; background:#f5f7fb; border-radius:6px; padding:8px 10px;"></p>

            <p style="margin:0 0 6px; font-weight:600;">Slots</p>
            <table id="npch-hk-slot-table" style="width:100%; border-collapse:collapse; font-size:13px;">
                <tbody></tbody>
            </table>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:18px;">
                <span style="color:#888; font-size:12px;">Ctrl+Alt+Numpad * toggles this sheet</span>
                <button id="npch-hk-edit" style="padding:7px 12px; border-radius:6px; border:none; background:#2563eb; color:#fff; cursor:pointer; font-weight:600;">Edit settings</button>
            </div>
        `;

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        hotkeysPanelEl = overlay;

        renderHotkeysSlotTable();

        panel.querySelectorAll('.npch-hk-bank-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                hotkeysActiveBank = btn.getAttribute('data-bank');
                renderHotkeysSlotTable();
            });
        });

        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeHotkeysPanel(); });
        panel.querySelector('#npch-hk-close').addEventListener('click', closeHotkeysPanel);
        panel.querySelector('#npch-hk-edit').addEventListener('click', () => {
            closeHotkeysPanel();
            openSettingsPanel();
        });
    }

    function closeHotkeysPanel() {
        if (hotkeysPanelEl) {
            hotkeysPanelEl.remove();
            hotkeysPanelEl = null;
        }
    }

    // Toggle the cheat sheet with Ctrl+Alt+Numpad Multiply (*)
    document.addEventListener('keydown', function (e) {
        const isNumpadMultiply = e.code === 'NumpadMultiply';
        if (isNumpadMultiply && e.ctrlKey && e.altKey) {
            e.preventDefault();
            isHotkeysPanelOpen() ? closeHotkeysPanel() : openHotkeysPanel();
        }
        // Escape closes whichever popup is open
        if (e.code === 'Escape') {
            if (isHotkeysPanelOpen()) closeHotkeysPanel();
        }
    }, true);

    /* ---------------------------------------------------------
       FLOATING ON-SCREEN PANEL (always visible, draggable)
       Bank row: 4 buttons to pick which bank the panel is showing
       Top row: buttons 1 2 3 4 5 6 7 8 9 0 → click to paste that slot
       Bottom box: "Text Prompt" → view/edit the selected slot's text
    --------------------------------------------------------- */
    const SLOT_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']; // matches the sketch's left-to-right order
    const PANEL_WIDTH = 34 * SLOT_ORDER.length + 28;
    let floatingPanelEl = null;
    let selectedSlot = '1';
    let selectedBank = '0';

    // Shared style constants so every stacked "card" in the panel has
    // identical border weight, color and corner radius, and every gap
    // between cards is the same size.
    const EDGE_BORDER = '2px solid #111';
    const EDGE_RADIUS = '8px';
    const EDGE_SHADOW = '0 4px 14px rgba(0,0,0,.18)';
    const EDGE_GAP = '6px';
    const DIVIDER = '1px solid #e5e5e5'; // internal (non-outer) dividers, kept consistent with each other

    function getPanelState() {
        // NOTE: "open" is intentionally NOT persisted anymore — see v102
        // change notes. Only where the panel sits and whether it's
        // minimized are remembered across sites/sessions.
        return Object.assign({ top: 24, left: 24, minimized: false }, GM_getValue('npch_panel_state', {}));
    }
    function setPanelState(state) {
        GM_setValue('npch_panel_state', state);
    }

    function buildFloatingPanel() {
        if (floatingPanelEl) return floatingPanelEl;

        const state = getPanelState();
        const panelWidth = PANEL_WIDTH;
        const wrap = document.createElement('div');
        wrap.id = 'npch-floating-panel';
        wrap.style.cssText = `
            position: fixed; top: ${state.top}px; left: ${state.left}px; z-index: 2147483645;
            font: 13px/1.4 -apple-system, Segoe UI, sans-serif; user-select: none;
        `;

        const bankButtons = BANK_DEFS.map(b => `
            <button data-bank="${b.key}" class="npch-fp-bankbtn" style="
                flex:1; padding:5px 2px; border:none; border-right:1px solid #ddd;
                background:#fff; font-size:11px; font-weight:700; cursor:pointer; color:#111;">${b.label.split('·')[1].trim()}</button>
        `).join('');

        wrap.innerHTML = `
            <div id="npch-fp-brand" style="
                position:relative; display:flex; align-items:center; gap:8px; background:#fff; border:${EDGE_BORDER}; border-radius:${EDGE_RADIUS};
                overflow:hidden; box-shadow:${EDGE_SHADOW}; margin-bottom:${EDGE_GAP}; width:${panelWidth}px;
                padding:6px 10px; cursor:grab; user-select:none;">
                <img id="npch-fp-logo" src="${LOGO_DATA_URI}" alt="EyeQ Monitoring" style="width:22px; height:22px; flex-shrink:0;">
                <strong id="npch-fp-brand-title" style="font-size:12.5px; color:#111; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1;">EyeQ Monitoring Hotkey Editor</strong>
                <button id="npch-fp-minimize" title="Minimize" style="
                    width:22px; height:22px; flex-shrink:0; border:1px solid #ddd; border-radius:5px;
                    background:#f5f5f5; color:#555; cursor:pointer; font-size:13px; line-height:1; padding:0;">&minus;</button>
            </div>
            <div id="npch-fp-bankrow" style="
                display:flex; background:#fff; border:${EDGE_BORDER}; border-radius:${EDGE_RADIUS};
                overflow:hidden; box-shadow:${EDGE_SHADOW}; margin-bottom:${EDGE_GAP}; width:${panelWidth}px;">
                ${bankButtons}
            </div>
            <div id="npch-fp-numrow" style="
                display:flex; background:#fff; border:${EDGE_BORDER}; border-radius:${EDGE_RADIUS};
                overflow:hidden; cursor:grab; box-shadow:${EDGE_SHADOW}; margin-bottom:${EDGE_GAP}; width:${panelWidth}px;">
                ${SLOT_ORDER.map(k => `
                    <button data-slot="${k}" class="npch-fp-numbtn" style="
                        flex:1; height:38px; border:none; border-right:1px solid #ddd;
                        background:#fff; font-size:15px; font-weight:700; cursor:pointer; color:#111;">${k}</button>
                `).join('')}
                <button id="npch-fp-close" title="Hide panel (this page only)" style="
                    width:28px; height:38px; flex-shrink:0; border:none; border-left:1px solid #ddd; background:#f5f5f5; color:#888; cursor:pointer; font-size:14px;">&times;</button>
            </div>
            <div id="npch-fp-mainbox" style="
                background:#fff; border:${EDGE_BORDER}; border-radius:${EDGE_RADIUS}; width:${panelWidth}px;
                box-shadow:${EDGE_SHADOW}; overflow:hidden;">
                <div id="npch-fp-header" style="
                    display:flex; align-items:center; justify-content:space-between;
                    border-bottom:${DIVIDER}; padding:8px 10px; cursor:grab; user-select:none;">
                    <strong id="npch-fp-title" style="font-size:13px;">Bank 1 · Plain — Slot 1</strong>
                    <span id="npch-fp-hint" style="font-size:11px; color:#999;">drag me</span>
                </div>
                <textarea id="npch-fp-textarea" placeholder="Type or paste text here, then Save..." style="
                    display:block; width:100%; height:180px; box-sizing:border-box; border:none; outline:none;
                    resize:vertical; padding:10px; font:13px/1.4 -apple-system, Segoe UI, sans-serif;"></textarea>
                <div style="display:flex; justify-content:flex-end; gap:6px; padding:8px 10px; border-top:${DIVIDER};">
                    <button id="npch-fp-insert" style="padding:6px 10px; border-radius:6px; border:1px solid #ccc; background:#f5f5f5; cursor:pointer;">Insert into page</button>
                    <button id="npch-fp-save" style="padding:6px 10px; border-radius:6px; border:none; background:#2563eb; color:#fff; cursor:pointer; font-weight:600;">Save</button>
                </div>
            </div>
        `;

        document.body.appendChild(wrap);
        floatingPanelEl = wrap;

        // Populate textarea with the currently selected bank/slot
        refreshFloatingPanel();

        // Bank buttons: click = switch which bank the numrow/textarea show.
        wrap.querySelectorAll('.npch-fp-bankbtn').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedBank = btn.getAttribute('data-bank');
                refreshFloatingPanel();
            });
        });

        // Number buttons: click = paste that slot (from the selected bank)
        // into the last active field, and also load it into the textarea
        // below for viewing/editing.
        wrap.querySelectorAll('.npch-fp-numbtn').forEach(btn => {
            btn.addEventListener('click', () => {
                const slotKey = btn.getAttribute('data-slot');
                selectedSlot = slotKey;
                refreshFloatingPanel();
                pasteFromSlot(selectedBank, slotKey, lastActiveElement);
            });
        });

        wrap.querySelector('#npch-fp-close').addEventListener('click', hideFloatingPanel);
        wrap.querySelector('#npch-fp-minimize').addEventListener('click', () => {
            if (getSettings().minimizeAction === 'disable') {
                toggleScriptEnabled();
            } else {
                setMinimized(!getPanelState().minimized);
            }
        });

        applyMinimizedState(getPanelState().minimized);
        applyMinimizeButtonMode();

        wrap.querySelector('#npch-fp-save').addEventListener('click', () => {
            const text = wrap.querySelector('#npch-fp-textarea').value;
            const banks = getBanks();
            banks[selectedBank][selectedSlot] = text;
            setBanks(banks);
            toast(`Saved to ${bankByKey(selectedBank).label} slot ${selectedSlot}`);
        });

        wrap.querySelector('#npch-fp-insert').addEventListener('click', () => {
            const text = wrap.querySelector('#npch-fp-textarea').value;
            if (!text) { toast('Nothing to insert'); return; }
            insertTextAtCursor(text, lastActiveElement);
        });

        makeDraggable(wrap, wrap.querySelector('#npch-fp-header'));
        makeDraggable(wrap, wrap.querySelector('#npch-fp-numrow'));
        makeDraggable(wrap, wrap.querySelector('#npch-fp-brand'), () => {
            if (getPanelState().minimized) setMinimized(false);
        });

        return wrap;
    }

    function refreshFloatingPanel() {
        if (!floatingPanelEl) return;
        const banks = getBanks();
        const bank = bankByKey(selectedBank);
        floatingPanelEl.querySelector('#npch-fp-title').textContent = `${bank.label} — Slot ${selectedSlot}`;
        floatingPanelEl.querySelector('#npch-fp-textarea').value = (banks[selectedBank] || {})[selectedSlot] || '';
        floatingPanelEl.querySelectorAll('.npch-fp-numbtn').forEach(btn => {
            const isSel = btn.getAttribute('data-slot') === selectedSlot;
            btn.style.background = isSel ? '#2563eb' : '#fff';
            btn.style.color = isSel ? '#fff' : '#111';
        });
        floatingPanelEl.querySelectorAll('.npch-fp-bankbtn').forEach(btn => {
            const isSel = btn.getAttribute('data-bank') === selectedBank;
            btn.style.background = isSel ? '#2563eb' : '#fff';
            btn.style.color = isSel ? '#fff' : '#111';
        });
    }

    // Minimizing collapses the panel down to a small round floating
    // bubble showing just the EyeQ logo (still draggable). Clicking the
    // bubble's badge expands it back to the full panel.
    function applyMinimizedState(minimized) {
        if (!floatingPanelEl) return;
        const brand = floatingPanelEl.querySelector('#npch-fp-brand');
        const logo = floatingPanelEl.querySelector('#npch-fp-logo');
        const bankrow = floatingPanelEl.querySelector('#npch-fp-bankrow');
        const numrow = floatingPanelEl.querySelector('#npch-fp-numrow');
        const mainbox = floatingPanelEl.querySelector('#npch-fp-mainbox');
        const title = floatingPanelEl.querySelector('#npch-fp-brand-title');
        const minBtn = floatingPanelEl.querySelector('#npch-fp-minimize');

        bankrow.style.display = minimized ? 'none' : 'flex';
        numrow.style.display = minimized ? 'none' : 'flex';
        mainbox.style.display = minimized ? 'none' : 'block';
        title.style.display = minimized ? 'none' : 'block';

        if (minimized) {
            brand.style.width = '48px';
            brand.style.height = '48px';
            brand.style.padding = '0';
            brand.style.gap = '0';
            brand.style.borderRadius = '50%';
            brand.style.justifyContent = 'center';
            brand.style.marginBottom = '0';
            logo.style.width = '28px';
            logo.style.height = '28px';
            minBtn.style.position = 'absolute';
            minBtn.style.right = '2px';
            minBtn.style.bottom = '2px';
            minBtn.style.width = '16px';
            minBtn.style.height = '16px';
            minBtn.style.borderRadius = '50%';
            minBtn.style.fontSize = '11px';
        } else {
            brand.style.width = PANEL_WIDTH + 'px';
            brand.style.height = 'auto';
            brand.style.padding = '6px 10px';
            brand.style.gap = '8px';
            brand.style.borderRadius = EDGE_RADIUS;
            brand.style.justifyContent = 'flex-start';
            brand.style.marginBottom = EDGE_GAP;
            logo.style.width = '22px';
            logo.style.height = '22px';
            minBtn.style.position = 'static';
            minBtn.style.width = '22px';
            minBtn.style.height = '22px';
            minBtn.style.borderRadius = '5px';
            minBtn.style.fontSize = '13px';
        }

        minBtn.innerHTML = minimized ? '&#9633;' : '&minus;';
        minBtn.title = minimized ? 'Expand' : 'Minimize';
    }

    function setMinimized(minimized) {
        applyMinimizedState(minimized);
        const state = getPanelState();
        setPanelState(Object.assign({}, state, { minimized }));
    }

    // Flips the whole script on/off. Used by the minimize button when its
    // action is set to "Disable the script instead" — see v106 change notes.
    // Disabling hides the panel entirely (not just dimmed) — use the
    // Tampermonkey menu command or Ctrl+Alt+Numpad Subtract to bring it
    // back into view so you can click the button again to re-enable.
    function toggleScriptEnabled() {
        const settings = getSettings();
        const nowEnabled = !settings.enabled;
        setSettings(Object.assign({}, settings, { enabled: nowEnabled }));
        toast(nowEnabled ? 'Hotkeys enabled' : 'Hotkeys disabled');
        applyMinimizeButtonMode();
        if (!nowEnabled) {
            hideFloatingPanel();
        }
    }

    // Updates the minimize button's icon/title/color to reflect which mode
    // it's in and, in "disable" mode, whether hotkeys are currently on or
    // off. Doesn't touch panel visibility or minimized/expanded state —
    // those are owned by hideFloatingPanel()/showFloatingPanel() and
    // applyMinimizedState() respectively.
    function applyMinimizeButtonMode() {
        if (!floatingPanelEl) return;
        const settings = getSettings();
        const minBtn = floatingPanelEl.querySelector('#npch-fp-minimize');
        if (settings.minimizeAction === 'disable') {
            const isEnabled = settings.enabled;
            minBtn.innerHTML = '&#9211;'; // power-style glyph
            minBtn.title = isEnabled ? 'Disable hotkeys (hides panel)' : 'Enable hotkeys (currently disabled)';
            minBtn.style.color = isEnabled ? '#555' : '#dc2626';
            minBtn.style.background = isEnabled ? '#f5f5f5' : '#fde8e8';
        } else {
            minBtn.style.color = '#555';
            minBtn.style.background = '#f5f5f5';
            // Icon/title for minimize mode is owned by applyMinimizedState().
            applyMinimizedState(getPanelState().minimized);
        }
    }

    function showFloatingPanel() {
        buildFloatingPanel();
        floatingPanelEl.style.display = 'block';
    }

    function hideFloatingPanel() {
        // Hides the panel for the current page load only. This is NOT
        // persisted to storage, so the panel goes back to auto-showing
        // (per its remembered position/minimized state) on the next page
        // or site — use this for "get it out of my way for a second",
        // not "I never want to see this again".
        if (floatingPanelEl) floatingPanelEl.style.display = 'none';
    }

    function toggleFloatingPanel() {
        const isOpen = floatingPanelEl && floatingPanelEl.style.display !== 'none';
        isOpen ? hideFloatingPanel() : showFloatingPanel();
    }

    function makeDraggable(panel, handle, onClick) {
        let dragging = false, offsetX = 0, offsetY = 0, startX = 0, startY = 0, moved = false;
        handle.addEventListener('mousedown', (e) => {
            // Ignore drags that start on a button
            if (e.target.closest('button')) return;
            dragging = true;
            moved = false;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            handle.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) moved = true;
            const left = Math.max(0, e.clientX - offsetX);
            const top = Math.max(0, e.clientY - offsetY);
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
        });
        document.addEventListener('mouseup', (e) => {
            if (!dragging) return;
            dragging = false;
            handle.style.cursor = 'grab';
            const rect = panel.getBoundingClientRect();
            const state = getPanelState();
            setPanelState(Object.assign({}, state, { top: rect.top, left: rect.left }));
            // A mousedown+mouseup with negligible movement is a click, not a
            // drag — let the handle react to it (e.g. expand the bubble).
            if (!moved && onClick) onClick(e);
        });
    }

    GM_registerMenuCommand('🔢 Toggle Floating Panel', toggleFloatingPanel);

    // Toggle the floating panel with Ctrl+Alt+Numpad Subtract (-)
    // Note: this combo can be intercepted by some OS/window-manager shortcuts
    // or by laptops emulating the numpad — use the Tampermonkey menu command
    // ("🔢 Toggle Floating Panel") as the guaranteed fallback.
    document.addEventListener('keydown', function (e) {
        const isNumpadMinus = e.code === 'NumpadSubtract' || (e.key === '-' && e.location === 3);
        if (isNumpadMinus && e.ctrlKey && e.altKey) {
            e.preventDefault();
            toggleFloatingPanel();
        }
    }, true);

    // The panel auto-shows on every page/site by default (position and
    // minimized/expanded state are still remembered — see v102 change
    // notes). Exception: if the minimize button is set to disable the
    // script instead, and hotkeys are currently off, stay hidden on load
    // too — use the Tampermonkey menu command or Ctrl+Alt+Numpad Subtract
    // to bring it back and re-enable. See v106 change notes.
    const startupSettings = getSettings();
    if (!(startupSettings.minimizeAction === 'disable' && !startupSettings.enabled)) {
        showFloatingPanel();
    }

})();
