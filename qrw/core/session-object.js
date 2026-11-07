// Session objects that are always destroyed without hiding the real error.

/**
 * Attach a cleanup failure to the primary error (never replace it).
 * @param {any} primary @param {any} cleanup
 */
export function addCleanupError(primary, cleanup) {
  if (primary && typeof primary === "object") (primary.cleanupErrors ??= []).push(cleanup);
  return primary;
}

/**
 * Create a session object, run `fn(obj)` and destroy the object. A destroy
 * failure after `fn` failed is attached to fn's error as `cleanupErrors`; a
 * destroy failure after success is thrown.
 * @template T
 * @param {any} doc @param {any} props @param {(obj: any) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSessionObject(doc, props, fn) {
  const obj = await doc.createSessionObject(props);
  let result;
  try {
    result = await fn(obj);
  } catch (e) {
    try { await doc.destroySessionObject(obj.id); } catch (ce) { addCleanupError(e, ce); }
    throw e;
  }
  await doc.destroySessionObject(obj.id);
  return result;
}
