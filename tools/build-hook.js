#!/usr/bin/env node
"use strict";

/**
 * Builds src/page-hook.js from:
 *   - src/lib/quotex.js          (pure Socket.IO adapter, sets CYBER_QUOTEX)
 *   - tools/page-hook.shell.js   (MAIN-world wrapper shell)
 *
 * The generated file is committed. Re-run after editing either input:
 *
 *     node tools/build-hook.js
 *
 * The MAIN world has no `chrome.runtime`, so the adapter MUST be inlined if
 * the extension is to decode the page's WebSocket traffic at document_start.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const adapter = fs.readFileSync(path.join(root, "src/lib/quotex.js"), "utf8");
const shell = fs.readFileSync(path.join(root, "tools/page-hook.shell.js"), "utf8");

const header = `/**
 * CYBER BINARY — GENERATED FILE. DO NOT EDIT BY HAND.
 *
 * Built by \`node tools/build-hook.js\` from:
 *   - src/lib/quotex.js        (protocol decoder / adapter)
 *   - tools/page-hook.shell.js (MAIN-world WebSocket hook shell)
 *
 * Rebuild after any change to either source file.
 * Generated: ${new Date().toISOString()}
 */
`;

const banner = `/* ====================================================================
 * Inlined CYBER_QUOTEX adapter (src/lib/quotex.js).
 * Exposes window.CYBER_QUOTEX in the page's MAIN world.
 * ==================================================================== */
`;

const out = header + banner + adapter + "\n\n" + banner.replace("Inlined CYBER_QUOTEX adapter (src/lib/quotex.js).", "MAIN-world WebSocket hook shell (tools/page-hook.shell.js).") + shell;

fs.writeFileSync(path.join(root, "src/page-hook.js"), out);
console.log("wrote src/page-hook.js (" + out.length + " bytes)");
