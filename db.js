/**
 * A&N Electricity Consumer Manager — IndexedDB Wrapper (db.js)
 * Version: 1.0.0
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
  async function addPendingChange(action, data, officeId) {
    await open();

    const change = {
      action,
      data,
      officeId,
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

  /** Count of pending changes (shown in UI sync badge) */
  async function getPendingCount() {
    await open();
    return p(store('pending_changes').count());
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
