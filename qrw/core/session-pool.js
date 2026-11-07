// A pool of QIX app sessions, browser-safe (no node: imports): the Node CLI
// and the browser live adapter open sessions the same way.

/** A random identity suffix: crypto.randomUUID where available (Node,
 * browsers in a secure context), else a random hex string. */
function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, "0")).join("-");
}

/**
 * A pool of app sessions, one per (app id, key), each with a unique identity
 * (a fresh session never shares selections with another one) and cleared
 * with clearAll() before use: fresh sessions can still inherit stale
 * selections. `fetch` keys sessions by scope id (one session per scope);
 * `extract` uses one per app. A session whose getDoc() or clearAll() fails
 * is closed at once and the original error is rethrown. Always close() the
 * pool in `finally`: it never throws and returns the close failures, so they
 * are reported separately and never replace the primary error.
 * @param {any} hostConfig
 * @param {{openAppSession: (props: any) => any, identityPrefix?: string}} opts
 */
export function createSessionPool(hostConfig, { openAppSession, identityPrefix = "qrw" }) {
  /** @type {Map<string, Promise<any>>} */
  const docs = new Map();
  /** @type {Set<any>} sessions opened and not yet closed */
  const open = new Set();
  return {
    /** @param {string} appId @param {string} [key] */
    getDoc(appId, key = "") {
      const k = JSON.stringify([appId, key]);
      if (!docs.has(k)) {
        docs.set(k, (async () => {
          const session = await openAppSession({ appId, hostConfig, identity: `${identityPrefix}-${uuid()}` });
          open.add(session);
          try {
            const doc = await session.getDoc();
            await doc.clearAll(false);
            return doc;
          } catch (e) {
            open.delete(session);
            try { await session.close(); } catch (ce) { (e.cleanupErrors ??= []).push(ce); }
            throw e;
          }
        })());
      }
      return /** @type {Promise<any>} */ (docs.get(k));
    },
    /** @returns {Promise<any[]>} close failures (empty when all closed) */
    async close() {
      await Promise.allSettled([...docs.values()]); // no session still opening
      const all = [...open];
      open.clear();
      docs.clear();
      const results = await Promise.allSettled(all.map((s) => s.close()));
      return results.filter((r) => r.status === "rejected").map((r) => /** @type {any} */ (r).reason);
    },
  };
}
