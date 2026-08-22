/**
 * Non-repainting signal markers.
 *
 * A marker is an immutable anchor: (asset, barTime, price, direction).
 * It is created exactly once per (asset, barTime, direction) — even if the
 * same signal re-fires — and its anchor never changes afterwards. Rendering
 * is purely presentational, so re-rendering the chart can never move an
 * arrow: signals are computed on CLOSED bars (see content.js), the anchor
 * is the closed bar's (time, close), and the chart (native lightweight-charts
 * markers, or our overlay) positions the arrow from that anchor alone.
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

  function createStore(opts) {
    var max = (opts && opts.max) || MAX_DEFAULT;
    var byAsset = Object.create(null);

    function add(m) {
      if (!m || m.time == null || !Number.isFinite(Number(m.time)) ||
          m.dir == null || m.price == null || !Number.isFinite(Number(m.price))) return false;
      var key = String(m.asset || "?");
      var list = byAsset[key] || (byAsset[key] = []);
      var time = Math.floor(Number(m.time));
      var dir = m.dir === "PUT" ? "PUT" : "CALL";
      // Dedupe by anchor: same (asset, bar, direction) never adds a second
      // marker. Meta (confidence/at) may be refreshed in place.
      for (var i = 0; i < list.length; i++) {
        if (list[i].time === time && list[i].dir === dir) {
          if (m.confidence != null) list[i].confidence = m.confidence;
          if (m.at != null) list[i].at = m.at;
          return false;
        }
      }
      list.push({
        asset: key,
        time: time,
        price: Number(m.price),
        dir: dir,
        confidence: m.confidence != null ? Number(m.confidence) : null,
        at: m.at != null ? Number(m.at) : Date.now(),
      });
      if (list.length > max) list.splice(0, list.length - max);
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
      return out;
    }

    function count(asset) {
      return asset != null ? (byAsset[String(asset)] || []).length
        : list().length;
    }

    function clear(asset) {
      if (asset != null) delete byAsset[String(asset)];
      else for (var key in byAsset) if (Object.prototype.hasOwnProperty.call(byAsset, key)) delete byAsset[key];
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
    var cap = (opts && opts.cap) || MAX_DEFAULT;
    var out = [];
    var byTime = Object.create(null);
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      if (!m || m.time == null || !Number.isFinite(Number(m.time))) continue;
      var sec = Math.floor(Number(m.time) / 1000);
      var dir = m.dir === "PUT" ? "PUT" : "CALL";
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
