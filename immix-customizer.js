// ==UserScript==
// @name         Immix Customizer
// @namespace    http://tampermonkey.net/
// @version      1.8.2
// @updateURL    http://10.161.1.16/Files/TMS.txt
// @downloadURL  http://10.161.1.16/Files/TMS.txt
// @description  try to take over the world!
// @author       Ava Herndon
// @match        https://*.smartviewplus.com/*
// @match        *://10.170.5.13/*
// @match        *://10.170.5.12/*
// @require      http://10.161.1.16/Files/TMS.js
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

var randomnumber = Math.floor(Math.random() * 1000000);
$('head').append(`<script type='text/javascript' src='http://10.161.1.16/Files/TMS.js?${randomnumber}' />`);
