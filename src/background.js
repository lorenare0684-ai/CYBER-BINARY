"use strict";

const DASH_W = 480;
const DASH_H = 820;
const QUOTEX_URL_RE = /(?:^|\.)(?:qxbroker|quotex)\.(?:com|io)(?:\/|$)/i;
let dashWindowId = null;
let dashOpening = null;
let primaryTabId = null;
let primarySelection = null;
let primaryEpoch = 0;
let activationEpoch = 0;
let primaryPersistQueue = Promise.resolve();
let lastStateEpoch = null;
const stateByTab = new Map();
const STORAGE_KEY = "cyberBinaryV2";
const STORAGE_ROOTS = new Set(["settings", "stats", "candles", "automation", "calibration"]);
let storagePatchQueue = Promise.resolve();
const primaryRestore = (async () => {
  let savedId = null;
  try {
    const saved = await chrome.storage.session.get("primaryTabId");
    const id = Number(saved && saved.primaryTabId);
    if (!Number.isInteger(id) || id < 0) {
      if (primaryTabId == null) persistPrimaryTab();
      return primaryTabId;
    }
    savedId = id;
    const tab = await chrome.tabs.get(id);
    // An activation event may have selected a newer owner while storage and
    // tab validation were in flight. Never let stale restoration overwrite it.
    if (primaryTabId == null && isQuotexTab(tab)) setPrimaryTab(id);
  } catch (_) {
    // Remove an invalid saved owner, but only if no live event selected one.
    if (savedId != null && primaryTabId == null) persistPrimaryTab();
  }
  return primaryTabId;
})();

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function applyStoragePatch(patch) {
  if (!Array.isArray(patch) || patch.length > 2000) throw new Error("invalid storage patch");
  const encoded = JSON.stringify(patch);
  if (encoded.length > 8 * 1024 * 1024) throw new Error("storage patch is too large");
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const current = data && data[STORAGE_KEY];
  const state = current && typeof current === "object" && !Array.isArray(current) ? cloneJson(current) : {};
  for (const op of patch) {
    if (!op || typeof op !== "object" || !Array.isArray(op.path) || !op.path.length || op.path.length > 10) {
      throw new Error("invalid storage patch operation");
    }
    const path = op.path.map((part) => String(part).replace(/[\u0000-\u001f\u007f]/g, " ").trim());
    if (!STORAGE_ROOTS.has(path[0]) || path.some((part) =>
      !part || part.length > 256 || part === "prototype" || Object.prototype.hasOwnProperty.call(Object.prototype, part))) {
      throw new Error("invalid storage patch path");
    }
    let parent = state;
    for (let i = 0; i < path.length - 1; i++) {
      const part = path[i];
      if (!parent[part] || typeof parent[part] !== "object" || Array.isArray(parent[part])) parent[part] = {};
      parent = parent[part];
    }
    const leaf = path[path.length - 1];
    if (op.remove === true) delete parent[leaf];
    else if (Object.prototype.hasOwnProperty.call(op, "value")) parent[leaf] = cloneJson(op.value);
    else throw new Error("storage patch has no value");
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function queueStoragePatch(patch) {
  const task = storagePatchQueue.then(() => applyStoragePatch(patch));
  storagePatchQueue = task.catch(() => {});
  return task;
}

function dashboardUrl() {
  return chrome.runtime.getURL("src/dashboard.html");
}

function isQuotexTab(tab) {
  if (!tab || !tab.url) return false;
  try {
    const u = new URL(tab.url);
    // A broker login/home/cabinet tab has no authoritative chart and must not
    // disarm the real trading tab merely because the user activated it.
    return QUOTEX_URL_RE.test(u.hostname + "/") && /trade|chart|trader|platform/i.test(u.pathname + u.search + u.hash);
  } catch (_) {
    return false;
  }
}

async function broadcastPrimary() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_) {}
  for (const tab of tabs || []) {
    if (!isQuotexTab(tab) || tab.id == null) continue;
    chrome.tabs.sendMessage(tab.id, {
      type: "CYBER_PRIMARY_CHANGED",
      primary: tab.id === primaryTabId,
      tabId: tab.id,
    }).catch(() => {});
  }
}

function persistPrimaryTab() {
  const epoch = primaryEpoch;
  const tabId = primaryTabId;
  primaryPersistQueue = primaryPersistQueue.catch(() => {}).then(async () => {
    // Skip queued stale writes. If a write was already in progress, the newer
    // queued operation still runs after it and makes storage converge.
    if (epoch !== primaryEpoch || tabId !== primaryTabId) return;
    if (tabId == null) await chrome.storage.session.remove("primaryTabId");
    else await chrome.storage.session.set({ primaryTabId: tabId });
  });
  return primaryPersistQueue;
}

function clearPrimaryTab(expectedTabId) {
  if (expectedTabId != null && expectedTabId !== primaryTabId) return false;
  if (primaryTabId == null) {
    persistPrimaryTab();
    return false;
  }
  primaryTabId = null;
  primaryEpoch++;
  persistPrimaryTab();
  return true;
}

function setPrimaryTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0 || tabId === primaryTabId) return false;
  primaryTabId = tabId;
  primaryEpoch++;
  persistPrimaryTab();
  broadcastPrimary();
  // Secondary tabs cannot refresh stateByTab, so this entry belongs to the
  // tab's previous ownership period. Replaying it would present an old asset
  // or balance as live until the promoted content script publishes again.
  stateByTab.delete(tabId);
  return true;
}

async function findBestQuotexTab() {
  try {
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const best = (active || []).find(isQuotexTab);
    if (best) return best;
  } catch (_) {}
  try {
    const tabs = await chrome.tabs.query({});
    return (tabs || []).find((t) => isQuotexTab(t) && t.active) ||
      (tabs || []).find(isQuotexTab) || null;
  } catch (_) {
    return null;
  }
}

async function selectInitialPrimary(fallbackTabId) {
  await primaryRestore;
  if (primaryTabId != null) return primaryTabId;
  if (!primarySelection) {
    primarySelection = (async () => {
      const selectionEpoch = primaryEpoch;
      const best = await findBestQuotexTab();
      if (primaryTabId != null || selectionEpoch !== primaryEpoch) return primaryTabId;
      const candidates = [];
      if (best && best.id != null) candidates.push(best.id);
      if (Number.isInteger(fallbackTabId) && fallbackTabId >= 0 && !candidates.includes(fallbackTabId)) {
        candidates.push(fallbackTabId);
      }
      for (const id of candidates) {
        let fresh;
        try { fresh = await chrome.tabs.get(id); } catch (_) { fresh = null; }
        if (primaryTabId != null || selectionEpoch !== primaryEpoch) break;
        if (isQuotexTab(fresh)) {
          setPrimaryTab(id);
          break;
        }
      }
      return primaryTabId;
    })().finally(() => { primarySelection = null; });
  }
  return primarySelection;
}

async function isPrimarySender(sender) {
  const tab = sender && sender.tab;
  if (!tab || tab.id == null || !isQuotexTab(tab)) return false;
  if (primaryTabId == null) await selectInitialPrimary(tab.id);
  return tab.id === primaryTabId;
}

async function getPrimaryTab() {
  await primaryRestore;
  // Tab activation/navigation/removal can occur while any tabs API promise is
  // pending. Re-check the ownership epoch after every await so an older lookup
  // can never retarget a dashboard command away from the user's latest tab.
  for (let attempt = 0; attempt < 4; attempt++) {
    const currentId = primaryTabId;
    const currentEpoch = primaryEpoch;
    if (currentId != null) {
      try {
        const current = await chrome.tabs.get(currentId);
        if (currentEpoch !== primaryEpoch || currentId !== primaryTabId) continue;
        if (isQuotexTab(current)) return current;
      } catch (_) {
        if (currentEpoch !== primaryEpoch || currentId !== primaryTabId) continue;
      }
      clearPrimaryTab(currentId);
      continue;
    }

    const searchEpoch = primaryEpoch;
    const candidate = await findBestQuotexTab();
    if (searchEpoch !== primaryEpoch || primaryTabId != null) continue;
    if (!candidate || candidate.id == null || !isQuotexTab(candidate)) return null;
    // Validate the query snapshot once more before assigning it. A tab can
    // navigate between tabs.query() and this selection point.
    let fresh;
    try { fresh = await chrome.tabs.get(candidate.id); } catch (_) { fresh = null; }
    if (searchEpoch !== primaryEpoch || primaryTabId != null) continue;
    if (!isQuotexTab(fresh)) continue;
    setPrimaryTab(fresh.id);
    return fresh;
  }
  // Under sustained tab churn, failing closed is safer than messaging a stale
  // chart. A subsequent heartbeat/dashboard request will retry selection.
  return null;
}

async function openDashboard() {
  if (dashOpening) return dashOpening;
  dashOpening = (async () => {
    if (dashWindowId != null) {
      try {
        await chrome.windows.update(dashWindowId, { focused: true });
        return dashWindowId;
      } catch (_) {
        dashWindowId = null;
      }
    }
    // Service workers restart and forget dashWindowId. Recover an existing
    // dashboard before creating one, otherwise each restart opens a duplicate.
    try {
      if (chrome.windows.getAll) {
        const windows = await chrome.windows.getAll({ populate: true });
        const wanted = dashboardUrl();
        const existing = (windows || []).find((w) =>
          (w.tabs || []).some((t) => String(t.url || "").split("#")[0] === wanted));
        if (existing && existing.id != null) {
          dashWindowId = existing.id;
          await chrome.windows.update(existing.id, { focused: true });
          return dashWindowId;
        }
      }
    } catch (_) {}
    const win = await chrome.windows.create({
      url: dashboardUrl(),
      type: "popup",
      width: DASH_W,
      height: DASH_H,
      focused: true,
    });
    dashWindowId = win && win.id != null ? win.id : null;
    return dashWindowId;
  })();
  try { return await dashOpening; }
  finally { dashOpening = null; }
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === dashWindowId) dashWindowId = null;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stateByTab.delete(tabId);
  if (tabId === primaryTabId) {
    clearPrimaryTab(tabId);
    getPrimaryTab().then(() => broadcastPrimary()).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener((info) => {
  // Increment even for dashboard/non-Quotex activations: an older unresolved
  // tabs.get() must not select the Quotex tab that is no longer active.
  const epoch = ++activationEpoch;
  if (!info || info.tabId == null) return;
  chrome.tabs.get(info.tabId).then((tab) => {
    // Activating the extension dashboard must not steal ownership. Activating
    // a Quotex tab explicitly makes that tab the one dashboard/auto follows.
    if (epoch === activationEpoch && isQuotexTab(tab)) setPrimaryTab(tab.id);
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === primaryTabId && changeInfo.url && !isQuotexTab(tab)) {
    stateByTab.delete(tabId);
    clearPrimaryTab(tabId);
    getPrimaryTab().then(() => broadcastPrimary()).catch(() => {});
    return;
  }
  if (tab && isQuotexTab(tab) && primaryTabId == null && (changeInfo.status === "complete" || changeInfo.url)) {
    selectInitialPrimary(tabId).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (isQuotexTab(tab) && tab.id != null) {
    setPrimaryTab(tab.id);
    try { await chrome.tabs.sendMessage(tab.id, { type: "CYBER_ATTACH" }); } catch (_) {}
  }
  await openDashboard();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // Ignore messages from subframes even if a browser keeps an older manifest
  // alive during an extension reload. Only one top-level content controller
  // may own signals, dashboard state, or trade execution.
  if (sender && sender.tab && sender.frameId != null && sender.frameId !== 0) {
    sendResponse({ ok: false, error: "top frame required" });
    return;
  }

  // Serialize partial state commits in the service worker. Previously every
  // dashboard/content context wrote the entire storage root, so two valid
  // simultaneous updates could silently erase each other.
  if (msg.type === "CYBER_STORAGE_PATCH") {
    if (!sender || sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "extension sender required" });
      return;
    }
    queueStoragePatch(msg.patch).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e && e.message || e) })
    );
    return true;
  }

  if (msg.type === "CYBER_REGISTER_SOURCE" || msg.type === "CYBER_IS_PRIMARY") {
    const tab = sender && sender.tab;
    if (!tab || tab.id == null || !isQuotexTab(tab)) {
      sendResponse({ ok: false, primary: false });
      return;
    }
    // Registration alone must never steal leadership: every browser window
    // can have an "active" tab, including background windows. During initial
    // selection prefer the active tab in the last-focused browser window,
    // rather than whichever content script happened to register first.
    if (primaryTabId == null) {
      selectInitialPrimary(tab.id).then(() => {
        sendResponse({ ok: true, primary: tab.id === primaryTabId, tabId: tab.id });
      }).catch(() => sendResponse({ ok: false, primary: false, tabId: tab.id }));
      return true;
    }
    sendResponse({ ok: true, primary: tab.id === primaryTabId, tabId: tab.id });
    return;
  }

  if (msg.type === "CYBER_OPEN_DASH") {
    // Opening/focusing the dashboard is not an ownership action. A stale or
    // secondary content tab must never steal main-chart leadership merely by
    // showing the dashboard; explicit tab activation/action clicks do that.
    openDashboard().then(() => sendResponse({ ok: true })).catch((e) => {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  if (msg.type === "CYBER_STATE") {
    const sourceTab = sender && sender.tab;
    const tabId = sourceTab && sourceTab.id;
    if (tabId == null || !isQuotexTab(sourceTab) || !msg.payload ||
        typeof msg.payload !== "object" || Array.isArray(msg.payload)) {
      sendResponse({ ok: false, error: "invalid Quotex state source" });
      return;
    }
    const stateTs = Number(msg.payload.ts);
    const arrayFields = ["candles", "chartCandles", "history", "markers"];
    const wrongArrayShape = arrayFields.some((field) =>
      Object.prototype.hasOwnProperty.call(msg.payload, field) && msg.payload[field] != null && !Array.isArray(msg.payload[field]));
    let stateSize = Infinity;
    try { stateSize = JSON.stringify(msg.payload).length; } catch (_) {}
    if (!Number.isFinite(stateTs) || stateTs < Date.now() - 86400000 || stateTs > Date.now() + 300000 ||
        wrongArrayShape || !Number.isFinite(stateSize) || stateSize > 8 * 1024 * 1024 ||
        (Array.isArray(msg.payload.candles) && msg.payload.candles.length > 10000) ||
        (Array.isArray(msg.payload.chartCandles) && msg.payload.chartCandles.length > 10000) ||
        (Array.isArray(msg.payload.history) && msg.payload.history.length > 1000) ||
        (Array.isArray(msg.payload.markers) && msg.payload.markers.length > 2000)) {
      sendResponse({ ok: false, error: "invalid or oversized Quotex state" });
      return;
    }
    if (!stateByTab.has(tabId) && stateByTab.size >= 100) stateByTab.delete(stateByTab.keys().next().value);
    stateByTab.set(tabId, msg.payload);
    const forwardState = () => {
      if (tabId !== primaryTabId) {
        sendResponse({ ok: true, primary: false });
        return;
      }
      lastStateEpoch = primaryEpoch;
      chrome.storage.session.set({ lastState: msg.payload, lastStateTabId: tabId }).catch(() => {});
      chrome.runtime.sendMessage({ type: "CYBER_STATE_PUSH", payload: msg.payload }).catch(() => {});
      sendResponse({ ok: true, primary: true });
    };
    if (primaryTabId == null) {
      selectInitialPrimary(tabId).then(forwardState).catch((e) => {
        sendResponse({ ok: false, primary: false, error: String(e) });
      });
      return true;
    }
    forwardState();
    return;
  }

  if (msg.type === "CYBER_GET_STATE") {
    getPrimaryTab().then(async (tab) => {
      const tabId = tab && tab.id != null ? tab.id : null;
      const current = tabId != null ? stateByTab.get(tabId) : null;
      const currentAge = current && Number.isFinite(Number(current.ts)) ? Date.now() - Number(current.ts) : Infinity;
      if (current && currentAge >= 0 && currentAge < 30000) {
        sendResponse({ ok: true, payload: current, tabId });
        return;
      }
      if (tabId != null && current) stateByTab.delete(tabId);
      const d = await chrome.storage.session.get(["lastState", "lastStateTabId"]);
      const saved = d && d.lastState;
      const savedAge = saved && Number.isFinite(Number(saved.ts)) ? Date.now() - Number(saved.ts) : Infinity;
      // null means this worker has just restarted, where the persisted owner is
      // still valid. A numeric mismatch means ownership changed in this worker
      // and the saved snapshot belongs to an earlier promotion of this tab.
      const epochValid = lastStateEpoch == null || lastStateEpoch === primaryEpoch;
      const fresh = epochValid && saved && d.lastStateTabId === tabId && savedAge >= 0 && savedAge < 15000;
      sendResponse({ ok: true, payload: fresh ? saved : null, tabId });
    }).catch((e) => sendResponse({ ok: false, payload: null, error: String(e) }));
    return true;
  }

  if (msg.type === "CYBER_NOTIFY") {
    isPrimarySender(sender).then(async (primary) => {
      const p = msg.payload;
      const direction = p && (p.direction === "CALL" || p.direction === "PUT") ? p.direction : "";
      if (!primary || !direction || !chrome.notifications || typeof chrome.notifications.create !== "function") {
        sendResponse({ ok: false, primary: !!primary });
        return;
      }
      const asset = String(p.asset || "").replace(/\s+/g, " ").trim().slice(0, 64);
      const confidence = Number(p.confidence);
      const reason = String(p.reason || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const message = ((asset ? asset + " · " : "") +
        (Number.isFinite(confidence) ? "confidence " + Math.max(0, Math.min(100, confidence)).toFixed(0) + "%" : "signal") +
        (reason ? " · " + reason : "")).slice(0, 240);
      await chrome.notifications.create("cyber-" + Date.now() + "-" + Math.floor(Math.random() * 100000), {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "CYBER BINARY " + direction,
        message,
      });
      sendResponse({ ok: true, primary: true });
    }).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  // Forward auto events only from the primary chart tab. This prevents two
  // armed Quotex tabs from both acting on the same shared settings.
  if (msg.type === "CYBER_AUTO_STATE" || msg.type === "CYBER_AUTO_LOG" || msg.type === "CYBER_AUTO_DECISION") {
    isPrimarySender(sender).then((primary) => {
      if (!primary) {
        sendResponse({ ok: false, primary: false });
        return;
      }
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ ok: true, primary: true });
    }).catch((e) => sendResponse({ ok: false, primary: false, error: String(e) }));
    return true;
  }

  // Dashboard setters always target the selected Quotex tab, never the first
  // arbitrary Quotex tab returned by chrome.tabs.query().
  if (msg.type === "CYBER_SET_ASSET" || msg.type === "CYBER_SET_STRATEGY" ||
      msg.type === "CYBER_SET_AUTO" || msg.type === "CYBER_DETECT_ASSET" ||
      msg.type === "CYBER_REQUEST_HISTORY" || msg.type === "CYBER_QUOTEX_SET_AUTH") {
    getPrimaryTab().then((tab) => {
      if (!tab || tab.id == null) {
        sendResponse({ ok: false, error: "No Quotex tab selected" });
        return;
      }
      chrome.tabs.sendMessage(tab.id, msg).then(
        (r) => sendResponse(r || { ok: true }),
        (e) => sendResponse({ ok: false, error: String(e && e.message || e) })
      );
    }).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // Forward platform events only from the primary tab.
  if (msg.type === "CYBER_QUOTEX_STATUS" || msg.type === "CYBER_QUOTEX_INSTRUMENTS" ||
      msg.type === "CYBER_QUOTEX_BALANCE" || msg.type === "CYBER_QUOTEX_TRADE_RESULT" ||
      msg.type === "CYBER_QUOTEX_TRADE_ERROR") {
    isPrimarySender(sender).then((primary) => {
      if (!primary) {
        sendResponse({ ok: false, primary: false });
        return;
      }
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ ok: true, primary: true });
    }).catch((e) => sendResponse({ ok: false, primary: false, error: String(e) }));
    return true;
  }
});
