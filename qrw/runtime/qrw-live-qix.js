// Live adapter for a standalone report page: runs the SAME spec in the
// browser with @qlik/api over OAuth (SPA client), one session per scope
// exactly like `qrw fetch`, and returns { meta, datasets } with
// meta.mode = "live". Load it as a module after qrw-runtime.js:
//   <script type="module" src=".../qrw-live-qix.js"></script>
// It registers itself with window.QRW; QRW.load() then uses it when the page
// is not baked and carries a live config (docs/report-template.md).
import { fetchSpec, resolveColumnMap } from "../core/fetch.js";
import { buildPayload } from "../core/bake.js";
import { createSessionPool } from "../core/session-pool.js";

/** Exact @qlik/api version loaded from the CDN (the one package.json pins). */
export const QLIK_API_VERSION = "2.23.0";
/** The package's browser ESM entry; its default export has `auth` and `qix`.
 * https://qlik.dev/toolkits/qlik-api/ (README: "load the code from a CDN") */
export const QLIK_API_URL = `https://cdn.jsdelivr.net/npm/@qlik/api@${QLIK_API_VERSION}/index.js`;

/**
 * @typedef {{host?: string, clientId: string, redirectUri: string,
 *   accessTokenStorage?: "session"|"local", scope?: string, spec: any,
 *   qlikApiUrl?: string, priority?: (string|string[])[], firstWaveTimeoutMs?: number,
 *   maxConcurrent?: number}} LiveConfig
 */

/**
 * OAuth SPA host config (no client secret in a browser): the user signs in
 * on the tenant and comes back through the registered redirect page.
 * https://qlik.dev/toolkits/qlik-api/authentication/
 * @param {LiveConfig} config
 */
export function oauthHostConfig(config) {
  for (const key of ["clientId", "redirectUri"]) {
    if (!config?.[key]) throw new Error(`live config needs "${key}"`);
  }
  const host = String(config.host || config.spec?.host || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host) throw new Error('live config needs "host" (or a spec with one)');
  return {
    authType: "oauth2", host, clientId: config.clientId, redirectUri: config.redirectUri,
    accessTokenStorage: config.accessTokenStorage || "session", autoRedirect: true,
    ...(config.scope ? { scope: config.scope } : {}),
  };
}

/**
 * Run the config's spec: one session per scope, closed afterwards whatever
 * happens; a failed dataset rejects the whole run (as in `qrw fetch`).
 * @param {LiveConfig} config
 * Progress goes to `hooks`: `onMeta(meta)` once before fetching (sections
 * known, links not yet), then `onDataset(id, dataset, columnMap)` as each
 * dataset arrives, first view first (`columnMap`: the resolved entries of
 * the original ids this dataset serves, or null). `hooks.priority` (the
 * page's QRW.priority) or `config.priority` overrides the fetch order;
 * `config.firstWaveTimeoutMs` / `config.maxConcurrent` tune it.
 * Before anything else, `deps.whoami()` reads the signed-in user's id from
 * the tenant and `hooks.onIdentity({host, userId})` receives it (awaited):
 * the runtime keys its per-viewer cache by it. No id (no whoami, a failure
 * or an empty answer): onIdentity is not called, so nothing is cached.
 * @param {LiveConfig} config
 * @param {{openAppSession: (props: any) => any, onCloseErrors?: (errors: any[]) => void,
 *   whoami?: () => Promise<string|null|undefined>}} deps
 * @param {{onMeta?: (meta: any) => void, onDataset?: (id: string, dataset: any, columnMap: any) => void,
 *   onIdentity?: (who: {host: string, userId: string}) => any, priority?: any}} [hooks]
 */
export async function runLive(config, { openAppSession, onCloseErrors = () => {}, whoami }, hooks = {}) {
  if (!config?.spec?.scopes || !Array.isArray(config.spec.datasets)) throw new Error('live config needs a "spec" with scopes and datasets');
  const hostConfig = oauthHostConfig(config);
  const spec = { ...config.spec, host: hostConfig.host };
  if (whoami && hooks.onIdentity) {
    let userId = null;
    try { userId = await whoami(); } catch { userId = null; }
    if (userId) await hooks.onIdentity({ host: hostConfig.host, userId: String(userId) });
  }
  const pool = createSessionPool(hostConfig, { openAppSession, identityPrefix: "qrw-live" });
  let data;
  try {
    hooks.onMeta?.(buildPayload(spec, { fetchedAt: null, datasets: {}, links: {} }, { mode: "live" }).meta);
    const entriesFor = (id) => Object.fromEntries(Object.entries(spec.columnMap || {}).filter(([, m]) => m.dataset === id));
    data = await fetchSpec(spec, (appId, scopeId) => pool.getDoc(appId, scopeId), {
      priority: hooks.priority ?? config.priority ?? null,
      ...(config.firstWaveTimeoutMs != null ? { firstWaveTimeoutMs: config.firstWaveTimeoutMs } : {}),
      ...(config.maxConcurrent != null ? { maxConcurrent: config.maxConcurrent } : {}),
      onDataset: (id, ds) => {
        const map = entriesFor(id);
        hooks.onDataset?.(id, ds, Object.keys(map).length ? resolveColumnMap(map, { [id]: ds }) : null);
      },
    });
  } finally {
    const errors = await pool.close();
    if (errors.length) onCloseErrors(errors);
  }
  return buildPayload(spec, data, { mode: "live" });
}

/** Import @qlik/api's browser entry (default export, or the namespace). */
export async function loadQlikApi(url = QLIK_API_URL) {
  const mod = await import(/* @vite-ignore */ url);
  return mod.default ?? mod;
}

/**
 * Register the adapter with a QRW runtime.
 * @param {any} qrw window.QRW
 * @param {{load?: (url?: string) => Promise<any>}} [deps]
 */
export function register(qrw, { load = loadQlikApi } = {}) {
  qrw.useLive(async (/** @type {LiveConfig} */ config, hooks = {}) => {
    const hostConfig = oauthHostConfig(config);
    const api = await load(config.qlikApiUrl);
    api.auth.setDefaultHostConfig(hostConfig);
    return runLive(config, {
      openAppSession: (props) => api.qix.openAppSession(props),
      // GET /api/v1/users/me with the session's own sign-in.
      // https://qlik.dev/apis/rest/users/#get-api-v1-users-me
      whoami: async () => (await api.users.getMyUser())?.data?.id ?? null,
      onCloseErrors: (errors) => console.warn("qrw: closing a session failed", errors),
    }, hooks);
  });
}

if (globalThis.QRW?.useLive) register(globalThis.QRW);
