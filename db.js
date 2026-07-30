/**
 * A&N Electricity Consumer Manager — IndexedDB Wrapper (db.js)
 * Version: 1.1.0
 *
 * Database : an_elect_db  (version 1)
 * Stores   :
 *   consumers       → Consumer records cached from Google Sheets
 *   pending_changes → Offline edits queued for sync
 *   config          → Key-value store (session, apiUrl, lastSync…)
 *
 * Usage:
 *   await AN_DB.getConsumer('CON001')
 *   await AN_DB.addPendingChange('editConsumer', data, officeId)
 */

const AN_DB = (() => {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────
  const DB_NAME    = 'an_elect_db';
  const DB_VERSION = 1;

  let _db = null; // Reuse connection across calls

  // ── Open / Schema ─────────────────────────────────────────────────────────────

  function open() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = event => {
        const db = event.target.result;
        console.log(`[DB] Creating schema v${DB_VERSION}...`);

        // Consumers — keyed by ConNo (unique identifier per consumer)
        if (!db.objectStoreNames.contains('consumers')) {
          const cs = db.createObjectStore('consumers', { keyPath: 'conNo' });
          cs.createIndex('sNo',          'sNo',          { unique: false });
          cs.createIndex('areaCode',     'areaCode',     { unique: false });
          cs.createIndex('status',       'status',       { unique: false });
          cs.createIndex('consumerName', 'consumerName', { unique: false });
        }

        // Pending changes — offline edits waiting to sync
        if (!db.objectStoreNames.contains('pending_changes')) {
          const ps = db.createObjectStore('pending_changes', {
            keyPath:       'id',
            autoIncrement: true,
          });
          ps.createIndex('action',    'action',    { unique: false });
          ps.createIndex('createdAt', 'createdAt', { unique: false });
        }

        // Config — simple key-value (session, apiUrl, lastSync, etc.)
        if (!db.objectStoreNames.contains('config')) {
          db.createObjectStore('config', { keyPath: 'key' });
        }
      };

      req.onsuccess = event => {
        _db = event.target.result;

        // Reset connection reference if DB is closed externally
        _db.onclose          = () => { _db = null; };
        _db.onversionchange  = () => { _db.close(); _db = null; };

        console.log('[DB] Opened an_elect_db successfully');
        resolve(_db);
      };

      req.onerror  = () => reject(req.error);
      req.onblocked = () => {
        console.warn('[DB] Open blocked — close other tabs and refresh');
      };
    });
  }

  // ── Internal Helpers ──────────────────────────────────────────────────────────

  /** Wrap an IDBRequest in a Promise */
  function p(idbRequest) {
    return new Promise((resolve, reject) => {
      idbRequest.onsuccess = () => resolve(idbRequest.result);
      idbRequest.onerror   = () => reject(idbRequest.error);
    });
  }

  /** Get an object store from a new transaction */
  function store(name, mode = 'readonly') {
    return _db.transaction(name, mode).objectStore(name);
  }

  // ── Config Store ──────────────────────────────────────────────────────────────

  async function setConfig(key, value) {
    await open();
    return p(store('config', 'readwrite').put({ key, value }));
  }

  async function getConfig(key) {
    await open();
    const result = await p(store('config').get(key));
    return result ? result.value : null;
  }

  async function removeConfig(key) {
    await open();
    return p(store('config', 'readwrite').delete(key));
  }

  // ── Session Helpers ───────────────────────────────────────────────────────────

  /**
   * Save session to BOTH localStorage (fast reads in main thread)
   * AND IndexedDB config (accessible by service worker during sync).
   * Call this after every successful login / session refresh.
   */
  async function saveSession(session) {
    try {
      localStorage.setItem('an_elect_session', JSON.stringify(session));
    } catch { /* Private browsing may block localStorage */ }
    await setConfig('session', session);
  }

  /** Read session — localStorage first (fast), IndexedDB as fallback */
  function getSession() {
    try {
      const raw = localStorage.getItem('an_elect_session');
      if (raw) return JSON.parse(raw);
    } catch { /* ignore parse error */ }
    return null;
  }

  /** Wipe session from both stores (called on logout) */
  async function clearSession() {
    try { localStorage.removeItem('an_elect_session'); } catch { /* ignore */ }
    await removeConfig('session');
  }

  // ── API URL Helper ────────────────────────────────────────────────────────────

  /**
   * Store the Apps Script URL so the service worker can use it during sync.
   * Call once on app init: await AN_DB.setApiUrl(API_URL);
   */
  async function setApiUrl(url) {
    return setConfig('apiUrl', url);
  }

  async function getApiUrl() {
    return getConfig('apiUrl');
  }

  // ── Consumer Store ────────────────────────────────────────────────────────────

  /**
   * Replace ALL consumers in the local cache.
   * Uses a single transaction: clears old data then inserts all new records atomically.
   * Call after a successful full fetch from Google Sheets.
   *
   * NOTE (Step 13 Phase 2): backgroundFullSync no longer calls this — it calls
   * mergeLiteConsumers() instead, so a lite sync can't wipe out previously-cached
   * full detail. Left in place, unused, in case a future "hard refresh" needs a
   * true full replace.
   *
   * @param {Array<object>} consumers  Array of consumer objects (must have .conNo)
   * @returns {Promise<number>}        Count of records written
   */
  async function setAllConsumers(consumers) {
    await open();

    return new Promise((resolve, reject) => {
      const tx  = _db.transaction('consumers', 'readwrite');
      const idb = tx.objectStore('consumers');

      idb.clear(); // Delete all existing records in this transaction
      for (const c of consumers) {
        idb.put(c); // Bulk insert
      }

      tx.oncomplete = () => {
        console.log(`[DB] Cached ${consumers.length} consumers`);
        resolve(consumers.length);
      };
      tx.onerror  = () => reject(tx.error);
      tx.onabort  = () => reject(new Error('setAllConsumers: transaction aborted'));
    });
  }

  /**
   * Fields returned by the server's "lite" getConsumers mode — exactly what
   * search/filter/sort/list-display/bulk-actions/OCR-match need. Kept as a
   * single list so the merge logic below and the sync caller can't drift apart.
   */
  /* 'sdPending' added for gap 7.4. This list is a WHITELIST: mergeLiteConsumers
     copies only these keys from a fresh lite row onto the cached record, so a
     server field missing from here is silently discarded on the first
     background sync - the badge would appear on load and then quietly vanish.
     It also feeds the dataChanged comparison below, so without it a consumer's
     SD being paid would not register as a change. */
  const LITE_FIELDS = ['conNo', 'consumerName', 'address', 'meterNo', 'transfCode', 'phoneNo', 'status', 'sdPassbookNo', 'sdPending', '_rowIndex'];

  /**
   * Merge a fresh "lite" server list into the local cache WITHOUT discarding
   * previously-fetched full detail (SD amount/date, lab no, audit fields,
   * custom field values, latest readings) for records that haven't changed.
   *
   * For each incoming record:
   *   - New record (never cached before)  → stored lite-only, _full: false
   *   - Cached, lite fields unchanged     → full detail kept, _full stays as-is
   *   - Cached, a lite field DID change   → full detail fields kept in the cache,
   *                                         but _full is forced to false — something
   *                                         changed server-side, safest to refetch
   *                                         full detail next time it's opened
   *
   * Records no longer present in the incoming list (deleted elsewhere) are dropped.
   * Same single-transaction clear+rewrite pattern as setAllConsumers.
   *
   * @param {Array<object>} liteList  Normalized lite consumer objects
   * @returns {Promise<{count:number, changed:boolean}>}
   *   `changed` is Step 16b's addition: true if anything a re-render would
   *   need to reflect is different — a new/removed consumer, a lite field
   *   value, OR a pure row-position shift (another session deleting a row
   *   above this one). Row position is included even though it doesn't
   *   invalidate `_full` (see `rowMoved` below): the in-memory `filtered`
   *   array's `_rowIndex` is sent verbatim on the next Edit/Delete call, so a
   *   stale one there is a data-safety risk, not just a cosmetic one, and
   *   must still trigger a refresh.
   */
  async function mergeLiteConsumers(liteList) {
    await open();
    const existing = await getAllConsumers();
    const byConNo = {};
    existing.forEach(c => { byConNo[c.conNo] = c; });

    const incoming = new Set();
    let anyChanged = existing.length !== liteList.length;

    const merged = liteList.map(liteC => {
      incoming.add(liteC.conNo);
      const prev = byConNo[liteC.conNo];

      if (!prev) {
        anyChanged = true;
        const fresh = { _full: false };
        LITE_FIELDS.forEach(k => { fresh[k] = liteC[k]; });
        return fresh;
      }

      // dataChanged (excludes _rowIndex) still controls _full invalidation,
      // exactly as before. rowMoved is tracked separately so a pure row-shift
      // still counts toward `anyChanged` without needlessly invalidating
      // already-cached full detail for a record whose data didn't change.
      const dataChanged = LITE_FIELDS.some(k => k !== '_rowIndex' && prev[k] !== liteC[k]);
      const rowMoved     = prev._rowIndex !== liteC._rowIndex;
      if (dataChanged || rowMoved) anyChanged = true;

      const base = Object.assign({}, prev, dataChanged ? { _full: false } : null);
      LITE_FIELDS.forEach(k => { base[k] = liteC[k]; });
      return base;
    });

    const finalList = merged.filter(c => incoming.has(c.conNo));

    return new Promise((resolve, reject) => {
      const tx  = _db.transaction('consumers', 'readwrite');
      const idb = tx.objectStore('consumers');
      idb.clear();
      for (const c of finalList) idb.put(c);
      tx.oncomplete = () => {
        console.log(`[DB] Merged ${finalList.length} lite consumers (changed: ${anyChanged})`);
        resolve({ count: finalList.length, changed: anyChanged });
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error('mergeLiteConsumers: transaction aborted'));
    });
  }

  /** Get all consumers from local cache */
  async function getAllConsumers() {
    await open();
    return p(store('consumers').getAll());
  }

  /** Get one consumer by ConNo */
  async function getConsumer(conNo) {
    await open();
    return p(store('consumers').get(conNo));
  }

  /** Insert or update a single consumer in the local cache */
  async function upsertConsumer(consumer) {
    await open();
    return p(store('consumers', 'readwrite').put(consumer));
  }

  /** Remove a consumer from the local cache */
  async function deleteConsumer(conNo) {
    await open();
    return p(store('consumers', 'readwrite').delete(conNo));
  }

  /** Count total consumers in cache */
  async function countConsumers() {
    await open();
    return p(store('consumers').count());
  }

  /**
   * Full-text search across name, ConNo, meter number, meter serial, phone.
   * Loads all ~300 records into memory — fine at this scale.
   *
   * @param {string} query  Text to search
   * @returns {Promise<Array>}
   */
  async function searchConsumers(query) {
    const all = await getAllConsumers();
    if (!query?.trim()) return all;

    const q = query.toLowerCase().trim();
    return all.filter(c =>
      (c.consumerName  || '').toLowerCase().includes(q) ||
      (c.conNo         || '').toLowerCase().includes(q) ||
      (c.meterNo       || '').toLowerCase().includes(q) ||
      (c.meterSerial   || '').toLowerCase().includes(q) ||
      (c.phone         || '').includes(q)
    );
  }

  /**
   * Filter consumers by area code.
   * @param {string} areaCode  e.g. 'OBS', 'RBV' — pass 'ALL' for no filter
   */
  async function filterByArea(areaCode) {
    const all = await getAllConsumers();
    if (!areaCode || areaCode === 'ALL') return all;
    return all.filter(c => c.areaCode === areaCode);
  }

  /**
   * Combined search + area filter in one call.
   * Used by the consumer list page.
   *
   * @param {string} query     Text search query (empty = all)
   * @param {string} areaCode  Area code filter (null/'ALL' = no filter)
   * @returns {Promise<Array>}
   */
  async function searchAndFilter(query, areaCode) {
    let results = await getAllConsumers();

    // Area filter first (cheaper)
    if (areaCode && areaCode !== 'ALL') {
      results = results.filter(c => c.areaCode === areaCode);
    }

    // Text search
    if (query?.trim()) {
      const q = query.toLowerCase().trim();
      results = results.filter(c =>
        (c.consumerName  || '').toLowerCase().includes(q) ||
        (c.conNo         || '').toLowerCase().includes(q) ||
        (c.meterNo       || '').toLowerCase().includes(q) ||
        (c.phone         || '').includes(q)
      );
    }

    return results;
  }

  // ── Pending Changes Store ─────────────────────────────────────────────────────

  /**
   * Queue an offline change for sync when internet returns.
   *
   * @param {string} action    'addConsumer' | 'editConsumer' | 'deleteConsumer'
   * @param {object} data      Full consumer object OR { conNo } for deletes
   * @param {string} officeId  Office ID from current session
   * @returns {Promise<number>} ID of the pending change record
   */
  async function addPendingChange(action, data, officeId, queuedBy) {
    await open();

    /* Gap 7.5. queuedBy records WHO created this change. The service worker
       will only replay a change under that same user, because the server
       stamps EnteredBy / LastEditedBy from the replaying session -- see the
       attribution guard in sw.js. Optional: entries queued without it stay
       replayable by anyone, which is the pre-7.5 behaviour. */
    const change = {
      action,
      data,
      officeId,
      queuedBy:   queuedBy || '',
      createdAt:  Date.now(),
      retryCount: 0,
    };

    const id = await p(store('pending_changes', 'readwrite').add(change));
    console.log(`[DB] Pending queued: ${action} (id: ${id})`);
    return id;
  }

  /** Get all pending changes (for manual sync or displaying count) */
  async function getPendingChanges() {
    await open();
    return p(store('pending_changes').getAll());
  }

  /**
   * Count of changes still genuinely waiting to sync.
   * Gap 7.5: dead-lettered entries are EXCLUDED -- they are not waiting for a
   * connection, they are waiting for a human, and are surfaced separately
   * through the save banner. Counting them here would show a number that
   * never goes down no matter how good the signal gets.
   */
  async function getPendingCount() {
    const all = await getPendingChanges();
    return all.filter(c => !c.deadLetter).length;
  }

  /**
   * Gap 7.5. One pass over the queue, split the three ways the UI needs:
   *   pending  - mine (or unattributed), will go on the next sync
   *   waiting  - queued by a different user, held until they log back in
   *   dead     - refused 5 times, needs a Retry or Discard decision
   */
  async function getQueueStats(username) {
    const all = await getPendingChanges();
    const me  = String(username || '');
    let pending = 0, waiting = 0, dead = 0;
    all.forEach(c => {
      if (c.deadLetter) dead++;
      else if (!c.queuedBy || String(c.queuedBy) === me) pending++;
      else waiting++;
    });
    return { pending, waiting, dead, total: all.length };
  }

  /** Gap 7.5. The dead-lettered entries, for the save banner. */
  async function getDeadLetters() {
    const all = await getPendingChanges();
    return all.filter(c => c.deadLetter);
  }

  /**
   * Gap 7.5. Put a dead-lettered change back in the live queue (banner Retry).
   * Clears the flag AND resets the retry budget, so a change that failed for a
   * since-fixed reason gets a fair five attempts again rather than dying on
   * the first one.
   */
  async function revivePendingChange(id) {
    await open();
    const rec = await p(store('pending_changes').get(id));
    if (!rec) return false;
    rec.deadLetter = false;
    rec.retryCount = 0;
    await p(store('pending_changes', 'readwrite').put(rec));
    return true;
  }

  /** Remove one pending change after it synced successfully */
  async function removePendingChange(id) {
    await open();
    return p(store('pending_changes', 'readwrite').delete(id));
  }

  /** Wipe all pending changes (destructive — only use if user resets/re-imports) */
  async function clearPending() {
    await open();
    return p(store('pending_changes', 'readwrite').clear());
  }

  // ── Sync Helpers ──────────────────────────────────────────────────────────────

  /**
   * Register a background sync with the service worker (Android Chrome only).
   * Falls back to manual: call this when network returns too.
   */
  async function requestSync() {
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.sync.register('sync-pending-changes');
        console.log('[DB] Background sync registered');
        return true;
      } catch (err) {
        console.warn('[DB] Background sync unavailable:', err.message);
      }
    }

    // Fallback: trigger sync via message to active service worker
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'TRIGGER_SYNC' });
      return true;
    }

    return false;
  }

  /** Save last successful sync timestamp */
  async function setLastSync(ts) {
    return setConfig('lastSync', ts || Date.now());
  }

  /** Get last successful sync timestamp (ms) */
  async function getLastSync() {
    return getConfig('lastSync');
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  /**
   * Clear all local consumer data (called on logout).
   * Preserves pending_changes so they can sync after re-login.
   */
  async function clearAllData() {
    await open();

    return new Promise((resolve, reject) => {
      const tx = _db.transaction(['consumers', 'config'], 'readwrite');

      tx.objectStore('consumers').clear();

      // Remove session + lastSync but keep apiUrl
      tx.objectStore('config').delete('session');
      tx.objectStore('config').delete('lastSync');

      tx.oncomplete = () => {
        console.log('[DB] Local data cleared');
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Full nuclear reset — wipe everything including pending changes.
   * Only call when user explicitly chooses "Reset App".
   */
  async function nukeAll() {
    await open();
    const tx = _db.transaction(['consumers', 'pending_changes', 'config'], 'readwrite');
    tx.objectStore('consumers').clear();
    tx.objectStore('pending_changes').clear();
    tx.objectStore('config').clear();
    return new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  return {
    open,

    // Config
    setConfig, getConfig, removeConfig,

    // Session
    saveSession, getSession, clearSession,

    // API URL
    setApiUrl, getApiUrl,

    // Consumers
    setAllConsumers,
    mergeLiteConsumers,
    getAllConsumers,
    getConsumer,
    upsertConsumer,
    deleteConsumer,
    countConsumers,
    searchConsumers,
    filterByArea,
    searchAndFilter,

    // Pending changes (offline queue)
    addPendingChange,
    getPendingChanges,
    getPendingCount,
    getQueueStats,
    getDeadLetters,
    revivePendingChange,
    removePendingChange,
    clearPending,

    // Sync
    requestSync,
    setLastSync,
    getLastSync,

    // Cleanup
    clearAllData,
    nukeAll,
  };

})();
