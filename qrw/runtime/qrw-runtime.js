// qrw-runtime: the browser side of a report template. A classic script (no
// build, no dependencies): inline it or load it with <script src>, then use
// window.QRW. Docs: docs/report-template.md.
(function (root) {
  "use strict";

  // Built from parts: a report that inlines this runtime must still contain
  // the placeholder exactly once (qrw bake counts it).
  var PLACEHOLDER = "__QRW_" + "DATA__";
  var ADAPTER_WAIT_MS = 15000;

  /** JSON safe inside a <script> element (same rule as qrw bake). */
  function scriptJson(value) {
    return JSON.stringify(value).replace(/</g, "\\u003c");
  }

  function isNullCell(c) {
    return c == null || c[0] == null || c[0] === "-";
  }

  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function num(c) {
    return c == null ? null : c[1] != null ? c[1] : c[0];
  }

  var CACHE_DB = "qrw-cache";
  var CACHE_STORE = "payloads";
  /** Upper bound of one cache operation: a stuck IndexedDB never holds up live data. */
  var CACHE_TIMEOUT_MS = 1500;

  /** FNV-1a (32 bit) of a string, as hex, plus its length: a compact spec id. */
  function hash(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8) + "-" + text.length;
  }

  /** A tiny promise wrapper over one IndexedDB object store. Every failure,
   * and every operation that has not settled within `timeoutMs`, rejects;
   * callers treat that as "no cache". */
  function openCache(factory, timeoutMs, timers) {
    function bounded(promise) {
      return new Promise(function (resolve, reject) {
        var timer = timers.setTimeout(function () { reject(new Error("QRW: cache operation timed out")); }, timeoutMs);
        promise.then(function (v) { timers.clearTimeout(timer); resolve(v); }, function (e) { timers.clearTimeout(timer); reject(e); });
      });
    }
    function open() {
      return new Promise(function (resolve, reject) {
        var req = factory.open(CACHE_DB, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(CACHE_STORE); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    function run(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(CACHE_STORE, mode);
          var req = fn(tx.objectStore(CACHE_STORE));
          tx.oncomplete = function () { db.close(); resolve(req.result); };
          tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
        });
      });
    }
    return {
      get: function (key) { return bounded(run("readonly", function (s) { return s.get(key); })); },
      put: function (key, value) { return bounded(run("readwrite", function (s) { return s.put(value, key); })); },
      del: function (key) { return bounded(run("readwrite", function (s) { return s.delete(key); })); },
    };
  }

  /**
   * @param {{document?: any, claude?: any, Blob?: any, URL?: any, CustomEvent?: any,
   *   setTimeout?: any, clearTimeout?: any}} env
   */
  function create(env) {
    var doc = env.document;
    var listeners = {};
    var adapter = null;
    var adapterWaiters = [];
    var api = {};

    // The page's own scripts and styles, recorded once the document is parsed:
    // anything added later (a library injecting its loader) is not the page's.
    var originals = typeof WeakSet === "function" ? new WeakSet() : null;
    var ORIGINAL_SELECTOR = "script, link, style, meta, base, #qrw-data, #qrw-live";
    function markOriginals() {
      if (!originals || !doc || !doc.querySelectorAll) return;
      var found = doc.querySelectorAll(ORIGINAL_SELECTOR);
      for (var i = 0; i < found.length; i++) originals.add(found[i]);
    }
    if (doc && doc.readyState === "loading" && doc.addEventListener) doc.addEventListener("DOMContentLoaded", markOriginals);
    else markOriginals();

    function emit(type, detail) {
      (listeners[type] || []).slice().forEach(function (fn) {
        try { fn(detail); } catch (e) { /* a listener's bug never breaks loading */ }
      });
      if (doc && doc.dispatchEvent && env.CustomEvent) doc.dispatchEvent(new env.CustomEvent("qrw:" + type, { detail: detail }));
    }

    function embedded() {
      var el = doc && doc.getElementById("qrw-data");
      var text = el ? String(el.textContent || "").trim() : "";
      if (!text || text === PLACEHOLDER) return null;
      return JSON.parse(text);
    }

    function liveConfig() {
      if (root.QRW_LIVE) return root.QRW_LIVE;
      var el = doc && doc.getElementById("qrw-live");
      return el ? JSON.parse(el.textContent) : null;
    }

    function waitForAdapter() {
      if (adapter) return Promise.resolve(adapter);
      return new Promise(function (resolve, reject) {
        var timer = (env.setTimeout || setTimeout)(function () {
          reject(new Error("QRW: a live config is present but no live adapter registered (load qrw-live-qix.js)"));
        }, ADAPTER_WAIT_MS);
        adapterWaiters.push(function (a) { (env.clearTimeout || clearTimeout)(timer); resolve(a); });
      });
    }

    /** Register the live adapter: (config) => Promise<{meta, datasets}>. */
    api.useLive = function (fn) {
      adapter = fn;
      adapterWaiters.splice(0).forEach(function (w) { w(fn); });
    };

    api.on = function (type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
      return api;
    };

    api.data = null;
    /** Live fetch order override: dataset ids (or arrays of ids), first view first. */
    api.priority = null;
    /** Optional per-viewer cache of the last live result: { key, maxAgeHours }. */
    api.cache = null;

    var waiters = [];
    var finished = false;
    var loadError = null;

    function present(id) {
      var d = api.data;
      if (!d) return false;
      if (hasOwn(d.datasets, id)) return true;
      var map = d.meta && d.meta.columnMap;
      return Boolean(map && hasOwn(map, id) && hasOwn(d.datasets, map[id].dataset));
    }

    /** Resolve every waiter whose datasets are all present; once loading
     * has finished (or failed), reject the rest. */
    function settleWaiters() {
      waiters = waiters.filter(function (w) {
        if (w.ids.every(present)) {
          try { w.resolve(w.ids.map(api.dataset)); } catch (e) { w.reject(e); }
          return false;
        }
        if (loadError) { w.reject(loadError); return false; }
        if (finished) {
          w.reject(new Error('QRW: unknown dataset(s) "' + w.ids.filter(function (id) { return !present(id); }).join('", "') + '"'));
          return false;
        }
        return true;
      });
    }

    /** Resolves [dataset, ...] once every listed dataset is present (a live
     * page receives them one by one; a snapshot has them all at once). */
    api.when = function (ids) {
      var list = Array.isArray(ids) ? ids.slice() : [ids];
      return new Promise(function (resolve, reject) {
        waiters.push({ ids: list, resolve: resolve, reject: reject });
        settleWaiters();
      });
    };

    function cacheStore() {
      var c = api.cache;
      if (!c || !c.key) return null;
      var timers = { setTimeout: env.setTimeout || setTimeout, clearTimeout: env.clearTimeout || clearTimeout };
      try { return env.indexedDB ? openCache(env.indexedDB, CACHE_TIMEOUT_MS, timers) : null; } catch (e) { return null; }
    }

    /** The entry key: the page's key, the signed-in viewer (effective host
     * and user id, as the live adapter verified them) and the spec. No
     * verified identity: no key, so no cache read or write. */
    function cacheKey(config, identity) {
      if (!identity || !identity.host || !identity.userId) return null;
      return JSON.stringify([String(api.cache.key), String(identity.host).toLowerCase(), String(identity.userId),
        hash(JSON.stringify(config.spec || null))]);
    }

    /** The cached live payload of this viewer and config, or null (missing,
     * expired, another spec, no identity, or no usable IndexedDB). */
    function readCache(config, identity) {
      var store = cacheStore();
      var key = store && cacheKey(config, identity);
      if (!key) return Promise.resolve(null);
      var maxAge = (Number(api.cache.maxAgeHours) > 0 ? Number(api.cache.maxAgeHours) : 24) * 3600 * 1000;
      return store.get(key).then(function (entry) {
        if (!entry || !entry.payload || entry.key !== key) return null;
        if (!(Date.now() - entry.savedAt <= maxAge)) return null;
        return entry;
      }).catch(function () { return null; });
    }

    function writeCache(config, identity, payload) {
      var store = cacheStore();
      var key = store && cacheKey(config, identity);
      if (!key) return Promise.resolve(false);
      return store.put(key, { key: key, savedAt: Date.now(), payload: payload })
        .then(function () { return true; }, function () { return false; });
    }

    function deleteCache(config, identity) {
      var store = cacheStore();
      var key = store && cacheKey(config, identity);
      if (!key) return Promise.resolve(false);
      return store.del(key).then(function () { return true; }, function () { return false; });
    }

    /**
     * Resolve {meta, datasets}: the embedded snapshot when baked, else the
     * live adapter when the page configures one. `opts.onDataset(id,
     * dataset)` is called for each dataset as it arrives (live: one by one;
     * snapshot: all at once). With QRW.cache set, a live page shows the
     * last cached live result of the SAME viewer (meta.mode "cached") once
     * the live adapter has verified who is signed in (hooks.onIdentity),
     * then swaps in live data. A failed live load deletes that viewer's
     * entry. Emits loading/cached/dataset/ready/error.
     * @param {{onDataset?: (id: string, dataset: any) => void}} [opts]
     */
    api.load = function (opts) {
      var onDataset = opts && opts.onDataset;
      finished = false;
      loadError = null;
      function deliver(id, ds) {
        if (onDataset) { try { onDataset(id, ds); } catch (e) { /* a template bug never breaks loading */ } }
        emit("dataset", { id: id, dataset: ds });
        settleWaiters();
      }
      var identity = null;
      var hooks = {
        priority: api.priority,
        /** The adapter's verified viewer {host, userId}: only now may the
         * cache be read. Resolves true when a cached result was shown. */
        onIdentity: function (who) {
          if (!who || !who.host || !who.userId) return Promise.resolve(false);
          identity = { host: String(who.host), userId: String(who.userId) };
          return readCache(live, identity).then(function (entry) {
            if (!entry || finished || loadError || Object.keys(arrived).length) return false;
            var meta = Object.assign({}, entry.payload.meta, { mode: "cached", cachedAt: new Date(entry.savedAt).toISOString() });
            api.data = { meta: meta, datasets: Object.assign({}, entry.payload.datasets) };
            emit("cached", api.data);
            Object.keys(api.data.datasets).forEach(function (id) { deliver(id, api.data.datasets[id]); });
            return true;
          });
        },
        onMeta: function (meta) {
          if (!(api.data && api.data.meta.mode === "cached")) api.data = { meta: Object.assign({}, meta), datasets: {} };
        },
        onDataset: function (id, ds, columnMap) {
          if (!api.data) return;
          arrived[id] = ds;
          api.data.datasets[id] = ds;
          if (columnMap) api.data.meta.columnMap = Object.assign({}, api.data.meta.columnMap, columnMap);
          deliver(id, ds);
        },
      };
      var live = null;
      var arrived = Object.create(null);
      emit("loading", {});
      return Promise.resolve().then(function () {
        var data = embedded();
        if (data) return data;
        live = liveConfig();
        if (!live) throw new Error("QRW: no embedded data (template not baked) and no live config");
        return waitForAdapter().then(function (a) { return a(live, hooks); });
      }).then(function (data) {
        if (!data || !data.meta || !data.datasets) throw new Error("QRW: data has no meta/datasets");
        api.data = data;
        Object.keys(data.datasets).forEach(function (id) {
          if (arrived[id] !== data.datasets[id]) deliver(id, data.datasets[id]);
        });
        finished = true;
        settleWaiters();
        if (live && data.meta.mode === "live") writeCache(live, identity, data);
        emit("ready", data);
        return data;
      }).catch(function (e) {
        // Terminal: any failure above (adapter, payload check, a delivery)
        // emits error and rejects every pending when().
        loadError = e;
        if (live) {
          // A denied or failed live load never leaves this viewer's cached
          // figures on screen or in storage.
          if (api.data && api.data.meta && api.data.meta.mode === "cached") api.data = null;
          deleteCache(live, identity);
        }
        settleWaiters();
        emit("error", e);
        throw e;
      });
    };

    function need() {
      if (!api.data) throw new Error("QRW: call QRW.load() first");
      return api.data;
    }

    /** A dataset by its id, or by an original (pre-merge) id through
     * meta.columnMap: then only that chart's columns, in its order. */
    api.dataset = function (id) {
      var data = need();
      if (data.datasets[id]) return data.datasets[id];
      var map = data.meta.columnMap && data.meta.columnMap[id];
      var ds = map && data.datasets[map.dataset];
      if (!ds) throw new Error('QRW: unknown dataset "' + id + '"');
      var nd = ds.columns.filter(function (c) { return c.kind === "dimension"; }).length;
      var out = {
        columns: map.columns.map(function (i) { return ds.columns[i]; }),
        rows: ds.rows.map(function (r) { return map.columns.map(function (i) { return r[i]; }); }),
        truncated: ds.truncated,
      };
      if (ds.totals) out.totals = map.columns.filter(function (i) { return i >= nd; }).map(function (i) { return ds.totals[i - nd]; });
      if (ds.unavailable) out.unavailable = ds.unavailable;
      if (map.hidden) out.hidden = map.hidden;
      return out;
    };

    /** The "condition not met" message of an unavailable dataset, else null. */
    api.unavailable = function (id) {
      var u = api.dataset(id).unavailable;
      return u ? (u.message || "Calculation condition not met") : null;
    };

    /** Rows without the null row (first cell null or "-"). */
    api.rows = function (id) {
      return api.dataset(id).rows.filter(function (r) { return !isNullCell(r[0]); });
    };

    function colIndex(ds, label, id) {
      var want = String(label).toLowerCase();
      for (var i = 0; i < ds.columns.length; i++) if (String(ds.columns[i].label).toLowerCase() === want) return i;
      throw new Error('QRW: dataset "' + id + '" has no column "' + label + '"');
    }

    /** One column's values (numbers where numeric, else text). */
    api.col = function (id, label) {
      var i = colIndex(api.dataset(id), label, id);
      return api.rows(id).map(function (r) { return num(r[i]); });
    };

    /** Target / Actual-or-Forecast / Delta from the first row, by column
     * label; delta is actual - target when there is no delta column. */
    api.tad = function (id) {
      var ds = api.dataset(id);
      var row = api.rows(id)[0] || [];
      function find(re) {
        for (var i = 0; i < ds.columns.length; i++) if (ds.columns[i].kind === "measure" && re.test(ds.columns[i].label)) return i;
        return -1;
      }
      var t = find(/target|budget|goal/i);
      var a = find(/actual/i);
      var forecast = a < 0;
      if (a < 0) a = find(/forecast|fcst|outlook/i);
      var d = find(/delta|diff|variance|vs\.?\s/i);
      var val = function (i) { return i < 0 || row[i] == null ? null : row[i][1]; };
      var target = val(t), actual = val(a);
      var delta = d >= 0 ? val(d) : target != null && actual != null ? actual - target : null;
      return {
        target: target, actual: actual, delta: delta, forecast: forecast && a >= 0,
        labels: { target: t >= 0 ? ds.columns[t].label : null, actual: a >= 0 ? ds.columns[a].label : null, delta: d >= 0 ? ds.columns[d].label : null },
        text: { target: t >= 0 && row[t] ? row[t][0] : null, actual: a >= 0 && row[a] ? row[a][0] : null, delta: d >= 0 && row[d] ? row[d][0] : null },
      };
    };

    /** Cross-tab of a straight dataset: row keys, column keys (first-seen
     * order) and values[row][col] = number. */
    api.pivot = function (id, rowDim, colDim, measure) {
      var ds = api.dataset(id);
      var ri = colIndex(ds, rowDim, id), ci = colIndex(ds, colDim, id), mi = colIndex(ds, measure, id);
      // Engine text as keys: prototype-free objects and own-property checks,
      // so "__proto__" or "constructor" are plain keys.
      var rows = [], cols = [], values = Object.create(null), seen = Object.create(null);
      api.rows(id).forEach(function (r) {
        var rk = r[ri][0], ck = r[ci][0];
        if (isNullCell(r[ci])) return;
        if (!hasOwn(values, rk)) { values[rk] = Object.create(null); rows.push(rk); }
        if (!hasOwn(seen, ck)) { seen[ck] = true; cols.push(ck); }
        values[rk][ck] = num(r[mi]);
      });
      return {
        rows: rows, cols: cols, values: values,
        get: function (r, c) { return hasOwn(values, r) && hasOwn(values[r], c) ? values[r][c] : null; },
      };
    };

    /** "report-snapshot-2026-11-07T12-00.html" from the fetch time. */
    function fileName(meta) {
      var title = (doc && doc.title ? doc.title : "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
      var at = String(meta.fetchedAt || "").slice(0, 16).replace(/:/g, "-") || "undated";
      return title + "-snapshot-" + at + ".html";
    }

    /** True for a script URL that works from a saved file anywhere: absolute
     * http(s) or a data: URL (a protocol-relative one is rewritten first). */
    function portableSrc(src) {
      return /^https?:\/\//i.test(src) || /^data:/i.test(src);
    }

    /**
     * The current document with the loaded data embedded as a snapshot,
     * built on a clone of the DOM: the data goes into the #qrw-data element
     * itself (never a text search over the page, which an inlined runtime
     * would confuse). The live config (#qrw-live) and the live adapter
     * script (src containing "qrw-live-qix", or data-qrw-live) are dropped:
     * a snapshot never signs in. A protocol-relative script URL ("//cdn...")
     * becomes https: (opened from disk it would resolve to file://). Any
     * other script loaded by a relative URL is refused: the saved file would
     * not be self-contained.
     */
    api.staticHtml = function () {
      var data = need();
      var payload = { meta: Object.assign({}, data.meta, { mode: "snapshot" }), datasets: data.datasets };
      var clone = doc.documentElement.cloneNode(true);
      var slot = clone.querySelector("#qrw-data");
      if (!slot) throw new Error("QRW: the page has no qrw-data script element to embed into");
      slot.textContent = scriptJson(payload);
      // Runtime-injected scripts and styles (SystemJS, embed loaders) are not
      // the page's: walk the live document and the clone in the same order.
      var CODE_SELECTOR = "script, link, style";
      var liveEls = doc.documentElement.querySelectorAll(CODE_SELECTOR);
      var cloneEls = clone.querySelectorAll(CODE_SELECTOR);
      var cfg = null;
      try { cfg = liveConfig(); } catch (e) { cfg = null; }
      var tenant = cfg && cfg.host ? String(cfg.host).replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase() : "";
      var stale = [];
      for (var k = 0; k < cloneEls.length; k++) {
        var node = cloneEls[k];
        var tag = String(node.tagName).toLowerCase();
        var isOriginal = !originals || (liveEls.length === cloneEls.length && originals.has(liveEls[k]));
        var injected = !isOriginal;
        if (tag === "link") {
          var rel = String(node.getAttribute("rel") || "").toLowerCase().split(/\s+/);
          if (!rel.some(function (r) { return r === "stylesheet" || r === "modulepreload" || r === "preload"; })) injected = false;
        }
        if (tag === "script") {
          var m = /^(?:https?:)?\/\/([^/?#:]+)/i.exec((node.getAttribute("src") || "").trim());
          var host = m ? m[1].toLowerCase() : "";
          if (host && (host === "cdn.qlikcloud.com" || (tenant && host === tenant))) injected = true;
        }
        if (injected) stale.push(node);
      }
      stale.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
      var drop = clone.querySelectorAll("#qrw-live, script[data-qrw-live], script[src*='qrw-live-qix']");
      for (var i = 0; i < drop.length; i++) drop[i].parentNode.removeChild(drop[i]);
      var scripts = clone.querySelectorAll("script[src]");
      var relative = [];
      for (var j = 0; j < scripts.length; j++) {
        var src = (scripts[j].getAttribute("src") || "").trim();
        if (/^\/\//.test(src)) { src = "https:" + src; scripts[j].setAttribute("src", src); }
        if (!portableSrc(src)) relative.push(src);
      }
      if (relative.length) {
        throw new Error("QRW: cannot save a self-contained copy: the page loads script(s) by relative URL (" +
          relative.join(", ") + "); inline them (qrw bake --inline-runtime) or load them from an absolute URL");
      }
      return "<!doctype html>\n" + clone.outerHTML;
    };

    /**
     * Offer a self-contained snapshot of the page as a download: through the
     * claude.ai artifact `downloads` capability when the page has it (the
     * viewer confirms; a refusal rejects with {code}), else a Blob and an
     * <a download> in a normal browser. Resolves {status, filename, via}.
     */
    api.saveStatic = function () {
      var html, filename;
      try {
        html = api.staticHtml();
        filename = fileName(api.data.meta);
      } catch (e) {
        return Promise.reject(e);
      }
      var claude = env.claude;
      var use = claude && typeof claude.use === "function" ? Promise.resolve(claude.use("downloads")).catch(function () { return null; }) : Promise.resolve(null);
      return use.then(function (downloads) {
        if (downloads) {
          return downloads.save({ filename: filename, data: html }).then(function (r) {
            return { status: (r && r.status) || "saved", filename: filename, via: "downloads" };
          }, function (e) {
            if (e && e.code === "declined") return { status: "declined", filename: filename, via: "downloads" };
            throw e;
          });
        }
        var blob = new env.Blob([html], { type: "text/html" });
        var url = env.URL.createObjectURL(blob);
        var a = doc.createElement("a");
        a.href = url;
        a.download = filename;
        doc.body.appendChild(a);
        a.click();
        a.remove();
        (env.setTimeout || setTimeout)(function () { env.URL.revokeObjectURL(url); }, 1000);
        return { status: "saved", filename: filename, via: "blob" };
      });
    };

    return api;
  }

  var qrw = create({
    document: root.document, get claude() { return root.claude; },
    get indexedDB() { try { return root.indexedDB; } catch (e) { return null; } }, Blob: root.Blob, URL: root.URL, CustomEvent: root.CustomEvent,
    setTimeout: root.setTimeout && root.setTimeout.bind(root), clearTimeout: root.clearTimeout && root.clearTimeout.bind(root),
  });
  qrw.create = create;
  root.QRW = qrw;
})(typeof window !== "undefined" ? window : globalThis);
