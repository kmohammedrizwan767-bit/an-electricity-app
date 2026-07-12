/**
 * A&N Electricity Consumer Manager — Service Worker (sw.js)
 * Version: 1.0.0
 *
 * Responsibilities:
 *  1. Cache static files on install (offline-first)
 *  2. Serve cached assets when offline
 *  3. Background sync: push pending offline edits to Google Sheets
 *  4. Update cache silently when network is available
 */

'use strict';

const CACHE_VERSION  = 'v1';
const CACHE_NAME     = `an-elect-${CACHE_VERSION}`;
const SYNC_TAG       = 'sync-pending-changes';
const DB_NAME        = 'an_elect_db';
const DB_VERSION     = 1;

// ── Assets to pre-cache ──────────────────────────────────────────────────────

const APP_ASSETS = [
  './login.html',
  './index.html',
  './superadmin.html',
  './manifest.json',
  './db.js',
];

const ICON_ASSETS = [
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const FONT_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Roboto:wght@400;500&display=swap',
  'https://fonts.googleapis.com/icon?family=Material+Icons+Round',
];

// ── Install ──────────────────────────────────────────────────────────────────

self.addEventListener('install', event => {
  console.log('[SW] Installing...');

  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      const all = [...APP_ASSETS, ...ICON_ASSETS, ...FONT_ASSETS];

      // Cache each individually — silently skip failures (e.g. icons not created yet)
      await Promise.allSettled(
        all.map(url =>
          fetch(url, { credentials: 'same-origin' })
            .then(res => { if (res.ok || res.type === 'opaque') cache.put(url, res); })
            .catch(err => console.warn('[SW] Cache miss (ok to ignore):', url))
        )
      );

      console.log('[SW] Install complete');
      return self.skipWaiting(); // Activate without waiting for old SW to die
    })
  );
});

// ── Activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', event => {
  console.log('[SW] Activating...');

  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          // Delete ALL previous an-elect caches
          .filter(k => k.startsWith('an-elect-') && k !== CACHE_NAME)
          .map(k => { console.log('[SW] Removing old cache:', k); return caches.delete(k); })
      ))
      .then(() => self.clients.claim()) // Take control of all open tabs immediately
  );
});

// ── Fetch Interception ────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Skip these entirely (pass to network) ──
  if (
    request.method !== 'GET'                          // POST/PUT/DELETE → don't intercept
    || url.protocol === 'chrome-extension:'           // Browser extensions
    || url.hostname.includes('script.google.com')    // Apps Script API calls
    || !url.protocol.startsWith('http')              // Non-HTTP
  ) return;

  // ── Google Fonts → Cache first (they never change) ──
  if (
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // ── App shell (HTML, JS, CSS, JSON, images) → Stale-while-revalidate ──
  if (
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js')   ||
    url.pathname.endsWith('.css')  ||
    url.pathname.endsWith('.json') ||
    url.pathname.endsWith('.png')  ||
    url.pathname.endsWith('.svg')  ||
    url.pathname.endsWith('.ico')  ||
    url.pathname === '/'
  ) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // ── Everything else → Network first ──
  event.respondWith(networkFirst(request));
});

// ── Background Sync ───────────────────────────────────────────────────────────

self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    console.log('[SW] Background sync triggered');
    event.waitUntil(syncPendingChanges());
  }
});

// ── Message Handler ───────────────────────────────────────────────────────────

self.addEventListener('message', event => {
  if (!event.data) return;

  switch (event.data.type) {
    case 'SKIP_WAITING':
      // New SW version ready — activate immediately
      self.skipWaiting();
      break;

    case 'TRIGGER_SYNC':
      // App came online — trigger manual sync
      syncPendingChanges();
      break;

    case 'UPDATE_CACHE_VERSION':
      // Force cache refresh (called after app update)
      caches.delete(CACHE_NAME);
      break;
  }
});

// ── Caching Strategies ────────────────────────────────────────────────────────

/** Cache-first: serve from cache, fall back to network */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    if (response.ok || response.type === 'opaque') {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback(request);
  }
}

/** Network-first: try network, fall back to cache */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || offlineFallback(request);
  }
}

/**
 * Stale-while-revalidate:
 * Immediately return cached version (fast), then update cache in background.
 * Best for app shell files that change occasionally.
 */
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Start network fetch in background (don't await yet)
  const fetchPromise = fetch(request)
    .then(response => {
      if (response.ok || response.type === 'opaque') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // Return cached immediately if available, otherwise wait for network
  return cached || (await fetchPromise) || offlineFallback(request);
}

/** Fallback response when offline and no cache available */
async function offlineFallback(request) {
  if (request.headers.get('Accept')?.includes('text/html')) {
    const cached = await caches.match('./login.html');
    return cached || new Response(
      '<h2>You are offline</h2><p>Open the app when connected to internet first.</p>',
      { headers: { 'Content-Type': 'text/html' }, status: 503 }
    );
  }
  return new Response('Offline — resource not available', { status: 503 });
}

// ── Sync Engine ───────────────────────────────────────────────────────────────

/**
 * Process all pending offline changes and push to Google Sheets.
 * Called by: Background Sync API OR manual trigger from main app.
 */
async function syncPendingChanges() {
  let db;

  try {
    db = await openDB();
  } catch (err) {
    console.error('[SW] DB open failed:', err);
    return;
  }

  // Read pending queue
  const pending = await dbGetAll(db, 'pending_changes');
  if (!pending.length) {
    console.log('[SW] No pending changes');
    return;
  }

  console.log(`[SW] Processing ${pending.length} pending changes...`);
  broadcast({ type: 'SYNC_STARTED', count: pending.length });

  // Get API URL and session (saved by main app on login)
  const apiUrl  = await dbGetConfig(db, 'apiUrl');
  const session = await dbGetConfig(db, 'session');

  if (!apiUrl || !session?.token) {
    console.warn('[SW] Cannot sync — missing API URL or session token');
    broadcast({ type: 'SYNC_FAILED', reason: 'NO_SESSION' });
    return;
  }

  let synced = 0;
  let failed = 0;

  for (const change of pending) {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          action:   change.action,
          token:    session.token,
          officeId: change.officeId || session.officeId,
          data:     change.data,
        }),
      });

      const result = await res.json();

      if (result.success) {
        // Remove from pending queue
        await dbDelete(db, 'pending_changes', change.id);
        synced++;
      } else {
        // Increment retry count; give up after 5 failures
        change.retryCount = (change.retryCount || 0) + 1;
        if (change.retryCount >= 5) {
          await dbDelete(db, 'pending_changes', change.id);
          console.warn('[SW] Dropped change after 5 retries:', change.id);
        } else {
          await dbPut(db, 'pending_changes', change);
        }
        failed++;
      }
    } catch (err) {
      console.error('[SW] Sync error for change', change.id, ':', err.message);
      failed++;
    }
  }

  console.log(`[SW] Sync complete — synced: ${synced}, failed: ${failed}`);
  broadcast({ type: 'SYNC_COMPLETE', synced, failed, remaining: failed });
}

// ── Mini IndexedDB Helpers (SW-side, self-contained) ─────────────────────────
// These mirror db.js but are standalone so the SW doesn't need importScripts.

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains('consumers')) {
        const cs = db.createObjectStore('consumers', { keyPath: 'conNo' });
        cs.createIndex('areaCode', 'areaCode', { unique: false });
        cs.createIndex('status',   'status',   { unique: false });
      }

      if (!db.objectStoreNames.contains('pending_changes')) {
        const ps = db.createObjectStore('pending_changes', { keyPath: 'id', autoIncrement: true });
        ps.createIndex('action',    'action',    { unique: false });
        ps.createIndex('createdAt', 'createdAt', { unique: false });
      }

      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(storeName)) { resolve([]); return; }
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

function dbGetConfig(db, key) {
  return new Promise(resolve => {
    if (!db.objectStoreNames.contains('config')) { resolve(null); return; }
    const req = db.transaction('config', 'readonly').objectStore('config').get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror   = () => resolve(null);
  });
}

function dbDelete(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

function dbPut(db, storeName, record) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── Broadcast to all tabs ─────────────────────────────────────────────────────
async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage(message));
}
