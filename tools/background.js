#!/usr/bin/env node
"use strict";

// Focused service-worker leadership race regressions.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

class FakeEvent {
  constructor() { this.listeners = []; }
  addListener(fn) { this.listeners.push(fn); }
  emit(...args) { for (const fn of this.listeners) fn(...args); }
}

const onActivated = new FakeEvent();
const onUpdated = new FakeEvent();
const onRemoved = new FakeEvent();
const onMessage = new FakeEvent();
const sentToTabs = [];
const sessionData = {};
const tabs = new Map([
  [1, { id: 1, url: "https://qxbroker.com/en/trade", active: false }],
  [2, { id: 2, url: "https://quotex.com/en/trade", active: true }],
  [3, { id: 3, url: "https://qxbroker.com/en/login", active: false }],
  [99, { id: 99, url: "chrome-extension://cyber/src/dashboard.html", active: true }],
]);
const deferredGets = new Map();

function deferNextGet(id) {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const queue = deferredGets.get(id) || [];
  queue.push({ promise, resolve });
  deferredGets.set(id, queue);
  return resolve;
}

const chrome = {
  runtime: {
    id: "cyber-test",
    getURL: (p) => "chrome-extension://cyber/" + p,
    onMessage,
    sendMessage: async () => ({}),
  },
  storage: {
    session: {
      get: async (key) => {
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (Object.prototype.hasOwnProperty.call(sessionData, k)) out[k] = sessionData[k];
        return out;
      },
      set: async (patch) => { Object.assign(sessionData, patch); },
      remove: async (key) => {
        for (const k of (Array.isArray(key) ? key : [key])) delete sessionData[k];
      },
    },
    local: { get: async () => ({}), set: async () => {} },
  },
  tabs: {
    onActivated,
    onUpdated,
    onRemoved,
    get: (id) => {
      const queue = deferredGets.get(id);
      if (queue && queue.length) {
        const item = queue.shift();
        if (!queue.length) deferredGets.delete(id);
        return item.promise;
      }
      const tab = tabs.get(id);
      return tab ? Promise.resolve({ ...tab }) : Promise.reject(new Error("missing tab"));
    },
    query: async () => Array.from(tabs.values(), (tab) => ({ ...tab })),
    sendMessage: async (id, message) => { sentToTabs.push({ id, message }); return { ok: true }; },
  },
  windows: {
    onRemoved: new FakeEvent(),
    getAll: async () => [],
    update: async () => ({}),
    create: async () => ({ id: 5 }),
  },
  action: { onClicked: new FakeEvent() },
  notifications: { create: async () => "notification" },
};

const sandbox = { chrome, URL, console, Date, Math, JSON, Map, Set, Promise };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8"), sandbox);

function flush() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

function request(message, tab) {
  return new Promise((resolve, reject) => {
    const listener = onMessage.listeners[0];
    if (!listener) return reject(new Error("message listener missing"));
    let answered = false;
    const sendResponse = (response) => { if (!answered) { answered = true; resolve(response); } };
    try {
      const asyncResponse = listener(message, { id: chrome.runtime.id, frameId: 0, tab: tab ? { ...tab } : undefined }, sendResponse);
      if (asyncResponse !== true && !answered) reject(new Error("message was not answered"));
    } catch (error) { reject(error); }
  });
}

let failed = 0;
function ok(condition, label) {
  if (condition) console.log("ok  ", label);
  else { console.error("FAIL", label); failed++; }
}

(async () => {
  await flush();

  // Resolve the newer activation first. The older tabs.get callback must not
  // steal leadership when it eventually arrives.
  const resolveOne = deferNextGet(1);
  const resolveTwo = deferNextGet(2);
  onActivated.emit({ tabId: 1 });
  onActivated.emit({ tabId: 2 });
  resolveTwo({ ...tabs.get(2) });
  await flush();
  resolveOne({ ...tabs.get(1) });
  await flush();
  const twoPrimary = await request({ type: "CYBER_IS_PRIMARY" }, tabs.get(2));
  const oneSecondary = await request({ type: "CYBER_IS_PRIMARY" }, tabs.get(1));
  ok(twoPrimary.primary === true && oneSecondary.primary === false,
    "out-of-order activation lookups keep the newest Quotex tab primary");

  // Even a non-Quotex activation invalidates an older pending lookup. It does
  // not itself steal the existing Quotex owner.
  const resolveOld = deferNextGet(1);
  onActivated.emit({ tabId: 1 });
  onActivated.emit({ tabId: 99 });
  await flush();
  resolveOld({ ...tabs.get(1) });
  await flush();
  const stillTwo = await request({ type: "CYBER_IS_PRIMARY" }, tabs.get(2));
  ok(stillTwo.primary === true, "dashboard activation cancels stale lookup without stealing ownership");

  onActivated.emit({ tabId: 3 });
  await flush();
  const afterLogin = await request({ type: "CYBER_IS_PRIMARY" }, tabs.get(2));
  const loginRejected = await request({ type: "CYBER_IS_PRIMARY" }, tabs.get(3));
  ok(afterLogin.primary === true && loginRejected.primary === false,
    "broker login/home tabs cannot steal chart leadership");

  // Begin a dashboard command while validating tab 2, then activate tab 1.
  // The pending command must re-check the epoch and target tab 1, not tab 2.
  const resolveStaleCommand = deferNextGet(2);
  sentToTabs.length = 0;
  const command = request({ type: "CYBER_SET_ASSET", asset: "EURUSD" }, null);
  await flush();
  onActivated.emit({ tabId: 1 });
  await flush();
  resolveStaleCommand({ ...tabs.get(2) });
  const commandResult = await command;
  await flush();
  const target = sentToTabs.find((entry) => entry.message && entry.message.type === "CYBER_SET_ASSET");
  ok(commandResult.ok === true && target && target.id === 1,
    "in-flight dashboard command follows the latest explicit tab activation");
  ok(sessionData.primaryTabId === 1, "serialized session persistence converges on the latest owner");

  const wrongStateShape = await request({
    type: "CYBER_STATE", payload: { ts: Date.now(), candles: { not: "an array" } },
  }, tabs.get(1));
  const oversizedState = await request({
    type: "CYBER_STATE", payload: { ts: Date.now(), candles: [], padding: "x".repeat(4 * 1024 * 1024 + 1) },
  }, tabs.get(1));
  ok(wrongStateShape.ok === false && oversizedState.ok === false,
    "malformed and storage-quota-sized state snapshots are rejected");

  if (failed) {
    console.error("\n" + failed + " background regression(s) failed");
    process.exit(1);
  }
  console.log("\nall background leadership tests pass");
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
