/**
 * Non-repainting signal markers.
 *
 * A marker is an immutable anchor: (asset, barTime, price, direction).
 * It is created exactly once per (asset, barTime, direction) — even if the
 * same signal re-fires — and its anchor never changes afterwards. Rendering
 * is purely presentational, so re-rendering the chart can never move an
 * arrow: signals are computed on CLOSED bars (see content.js), and the anchor
 * is the resulting entry candle's (open time, entry price). The chart (native
 * lightweight-charts markers, or our overlay) positions the arrow from that
 * anchor alone.
 *
 * Exposes:
 *   CYBER_MARKERS.createStore(opts)  -> { add, seedHistory, list, count, clear }
 *   CYBER_MARKERS.toNative(list)     -> [{time(sec), position, color, shape, text}]
 */
(function (root) {
  "use strict";

  var CALL_COLOR = "#3dff9a";
  var PUT_COLOR = "#ff5d7a";
  var MAX_DEFAULT = 600;

  function numberOrNull(value) {
    try {
      var n = Number(value);
      return Number.isFinite(n) ? n : null;
    } catch (_) { return null; }
  }

  function createStore(opts) {
    var requestedMax = numberOrNull(opts && opts.max);
    var max = Number.isFinite(requestedMax) && requestedMax >= 1
      ? Math.min(5000, Math.floor(requestedMax)) : MAX_DEFAULT;
    var byAsset = Object.create(null);
    var anchorsByAsset = Object.create(null);
    var assetCount = 0;

    function confidence(value) {
      var n = numberOrNull(value);
      return n != null ? Math.max(0, Math.min(100, n)) : null;
    }

    function safeAt(value) {
      var n = numberOrNull(value);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    }

    function add(m) {
      var rawTime = m ? numberOrNull(m.time) : null;
      var price = m ? numberOrNull(m.price) : null;
      var key = m && typeof m.asset === "string" ? m.asset.trim() : "";
      if (!m || !Number.isSafeInteger(rawTime) || rawTime < 0 ||
          (m.dir !== "CALL" && m.dir !== "PUT") || !Number.isFinite(price) ||
          price <= 0 || price > 1e15 || !/^[A-Za-z0-9._-]{1,64}$/.test(key)) return false;
      var list = byAsset[key];
      if (!list) {
        if (assetCount >= 512) return false;
        list = byAsset[key] = [];
        anchorsByAsset[key] = Object.create(null);
        assetCount++;
      }
      var time = rawTime;
      var dir = m.dir === "PUT" ? "PUT" : "CALL";
      var anchorKey = time + ":" + dir;
      var existing = anchorsByAsset[key][anchorKey];
      // Dedupe by anchor: same (asset, bar, direction) never adds a second
      // marker. Meta (confidence/at) may be refreshed in place.
      if (existing) {
        if (m.confidence != null) existing.confidence = confidence(m.confidence);
        if (m.at != null) {
          var refreshedAt = safeAt(m.at);
          if (refreshedAt != null) existing.at = refreshedAt;
        }
        return false;
      }
      var suppliedAt = safeAt(m.at);
      var marker = {
        asset: key,
        time: time,
        price: price,
        dir: dir,
        confidence: m.confidence != null ? confidence(m.confidence) : null,
        at: suppliedAt != null ? suppliedAt : Date.now(),
      };
      list.push(marker);
      anchorsByAsset[key][anchorKey] = marker;
      if (list.length > max) {
        var removed = list.splice(0, list.length - max);
        for (var i = 0; i < removed.length; i++) delete anchorsByAsset[key][removed[i].time + ":" + removed[i].dir];
      }
      return true;
    }

    /** Seed from settled trade history: {asset, at, entry, dir, confidence}. */
    function seedHistory(list) {
      var n = 0;
      if (!Array.isArray(list)) return n;
      for (var i = 0; i < list.length; i++) {
        var h = list[i];
        if (h && h.at != null && h.entry != null && h.dir) {
          if (add({ asset: h.asset, time: h.at, price: h.entry, dir: h.dir, confidence: h.confidence, at: h.at })) n++;
        }
      }
      return n;
    }

    /** Markers for one asset (or all assets when omitted), oldest first. */
    function list(asset) {
      var out = [];
      if (asset != null) {
        out = (byAsset[String(asset)] || []).slice();
      } else {
        for (var key in byAsset) {
          if (Object.prototype.hasOwnProperty.call(byAsset, key)) {
            out = out.concat(byAsset[key]);
          }
        }
      }
      out.sort(function (a, b) { return a.time - b.time; });
      // Return detached records so dashboard/consumer edits cannot mutate an
      // anchor held by the non-repainting store.
      return out.map(function (marker) { return Object.assign({}, marker); });
    }

    function count(asset) {
      return asset != null ? (byAsset[String(asset)] || []).length
        : list().length;
    }

    function clear(asset) {
      if (asset != null) {
        var key = String(asset);
        if (byAsset[key]) assetCount--;
        delete byAsset[key];
        delete anchorsByAsset[key];
      } else {
        byAsset = Object.create(null);
        anchorsByAsset = Object.create(null);
        assetCount = 0;
      }
    }

    return { add: add, seedHistory: seedHistory, list: list, count: count, clear: clear };
  }

  /**
   * Convert markers into the lightweight-charts v4/v5 `series.setMarkers()`
   * format: UTC seconds, sorted ascending, unique per bar time (the chart
   * library keys markers by time — two arrows on the same bar can't both
   * exist, so the newest one wins), capped.
   */
  function toNative(list, opts) {
    var requestedCap = numberOrNull(opts && opts.cap);
    var cap = Number.isFinite(requestedCap) && requestedCap >= 1
      ? Math.min(5000, Math.floor(requestedCap)) : MAX_DEFAULT;
    var out = [];
    var byTime = Object.create(null);
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      if (!m || m.time == null) continue;
      var rawTime = numberOrNull(m.time);
      if (rawTime == null) continue;
      while (Math.abs(rawTime) >= 1e14) rawTime /= 1000;
      var sec = Math.floor(Math.abs(rawTime) >= 1e11 ? rawTime / 1000 : rawTime);
      if (!Number.isSafeInteger(sec) || sec < 0 || (m.dir !== "CALL" && m.dir !== "PUT")) continue;
      var dir = m.dir;
      byTime[sec] = {
        time: sec,
        position: dir === "PUT" ? "aboveBar" : "belowBar",
        color: dir === "PUT" ? PUT_COLOR : CALL_COLOR,
        shape: dir === "PUT" ? "arrowDown" : "arrowUp",
        text: dir === "PUT" ? "PUT" : "CALL",
      };
    }
    for (var t in byTime) {
      if (Object.prototype.hasOwnProperty.call(byTime, t)) out.push(byTime[t]);
    }
    out.sort(function (a, b) { return a.time - b.time; });
    if (out.length > cap) out = out.slice(out.length - cap);
    return out;
  }

  root.CYBER_MARKERS = { createStore: createStore, toNative: toNative };
})(typeof self !== "undefined" ? self : globalThis);
