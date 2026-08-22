"use strict";

const DASH_W = 440;
const DASH_H = 720;
let dashWindowId = null;

function dashboardUrl() {
  return chrome.runtime.getURL("src/dashboard.html");
}

async function openDashboard() {
  if (dashWindowId != null) {
    try {
      await chrome.windows.update(dashWindowId, { focused: true });
      return;
    } catch (_) {
      dashWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: dashboardUrl(),
    type: "popup",
    width: DASH_W,
    height: DASH_H,
    focused: true,
  });
  dashWindowId = win.id;
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === dashWindowId) dashWindowId = null;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab && tab.id != null) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "CYBER_ATTACH" });
    } catch (_) {
      /* not a Quotex tab — still open dashboard */
    }
  }
  await openDashboard();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "CYBER_OPEN_DASH") {
    openDashboard().then(() => sendResponse({ ok: true })).catch((e) => {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  if (msg.type === "CYBER_STATE") {
    chrome.storage.session.set({ lastState: msg.payload }).catch(() => {});
    chrome.runtime.sendMessage({ type: "CYBER_STATE_PUSH", payload: msg.payload }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "CYBER_GET_STATE") {
    chrome.storage.session.get("lastState").then((d) => {
      sendResponse({ ok: true, payload: d.lastState || null });
    });
    return true;
  }
});
