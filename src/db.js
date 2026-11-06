// ============ IndexedDB Storage ============

var DB_NAME = 'VinylCollectionPlayer';
var DB_VERSION = 10;
var _db = null;
var _dbOpening = null;   // the open in progress, shared by every caller
var _dbBlockedToast = null;

// An Error for a database that would not open (P6), with a message that says
// why in plain words and what to do. The browser's own error is kept as
// `cause` and its name as `dbErrorName`. The router's error screen shows the
// message (src/view_state.js).
function dbOpenError(cause) {
    var name = cause ? (cause.name || 'Error') : 'MissingIndexedDB';
    var msg;
    if (!cause) {
        msg = 'This browser does not offer the storage (IndexedDB) the app keeps your collection in. ' +
            'Use a current Chrome, Firefox, Safari or Edge, outside private browsing.';
    } else if (name === 'VersionError') {
        msg = 'Your saved data was written by a newer version of the app than this page. ' +
            'Reload the page to get the newest version; if this stays, clear the browser cache for this site.';
    } else if (name === 'InvalidStateError' || name === 'SecurityError') {
        msg = 'The browser is not letting this site store data, as happens in private browsing or when ' +
            'site data is blocked. Open the app in a normal window, or allow site data for it, then try again.';
    } else if (name === 'QuotaExceededError') {
        msg = 'The browser has no storage space left for this site. Free some disk space, then try again.';
    } else {
        msg = 'The browser could not open the app\'s saved data (' + name + (cause.message ? ': ' + cause.message : '') + '). ' +
            'Try again; if it keeps happening, restart the browser.';
    }
    var err = new Error(msg);
    err.name = 'DbOpenError';
    err.dbErrorName = name;
    err.cause = cause || null;
    return err;
}

function openDB() {
    if (_db) return Promise.resolve(_db);
    if (_dbOpening) return _dbOpening;
    var req;
    try {
        if (typeof indexedDB === 'undefined' || !indexedDB) throw null;
        req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
        // Missing outright, or open() itself refused (e.g. a sandboxed frame).
        // Not cached: "Try again" opens afresh.
        return Promise.reject(dbOpenError(e));
    }
    // The open in progress is forgotten inside the request's own handlers, not
    // in a later .then: the connection can close (onclose) before that runs,
    // and openDB() would then hand out the closed one.
    _dbOpening = new Promise(function (resolve, reject) {
        req.onupgradeneeded = function (e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains('releases')) {
                var rs = db.createObjectStore('releases', { keyPath: 'id' });
                rs.createIndex('artist', 'artist');
                rs.createIndex('title', 'title');
                rs.createIndex('year', 'year');
                rs.createIndex('date_added', 'date_added');
            }
            if (!db.objectStoreNames.contains('videos')) {
                var vs = db.createObjectStore('videos', { keyPath: 'id', autoIncrement: true });
                vs.createIndex('release_id', 'release_id');
                vs.createIndex('youtube_id', 'youtube_id');
            }
            if (!db.objectStoreNames.contains('folders')) {
                db.createObjectStore('folders', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('config')) {
                db.createObjectStore('config', { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains('track_meta')) {
                var tm = db.createObjectStore('track_meta', { keyPath: 'id' });
                tm.createIndex('release_id', 'release_id');
                tm.createIndex('bpm', 'bpm');
                tm.createIndex('key', 'key');
                tm.createIndex('rating', 'rating');
            }
            if (!db.objectStoreNames.contains('setlists')) {
                var sl = db.createObjectStore('setlists', { keyPath: 'id', autoIncrement: true });
                sl.createIndex('name', 'name');
                sl.createIndex('updated_at', 'updated_at');
            }
            if (!db.objectStoreNames.contains('tracklist')) {
                var tl = db.createObjectStore('tracklist', { keyPath: 'id' });
                tl.createIndex('release_id', 'release_id');
            }
            if (!db.objectStoreNames.contains('wants')) {
                var ws = db.createObjectStore('wants', { keyPath: 'id' });
                ws.createIndex('date_added', 'date_added');
                ws.createIndex('artist', 'artist');
            }
            if (!db.objectStoreNames.contains('marketplace_stats')) {
                db.createObjectStore('marketplace_stats', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('store_items')) {
                var sti = db.createObjectStore('store_items', { keyPath: 'id' });
                sti.createIndex('serial', 'serial');
                sti.createIndex('store_status', 'store_status');
                sti.createIndex('batch_id', 'batch_id');
            }
            if (!db.objectStoreNames.contains('store_batches')) {
                var sbatch = db.createObjectStore('store_batches', { keyPath: 'id', autoIncrement: true });
                sbatch.createIndex('name', 'name');
            }
            if (!db.objectStoreNames.contains('notifications')) {
                var ns = db.createObjectStore('notifications', { keyPath: 'id', autoIncrement: true });
                ns.createIndex('release_id', 'release_id');
                ns.createIndex('seen', 'seen');
                ns.createIndex('created_at', 'created_at');
            }
            // v9: one row per marketplace reading worth keeping (a change, or a
            // daily heartbeat), keyed `<release_id>_<checked_at>` so rows from a
            // backup merge with local ones instead of colliding on an
            // auto-increment id.
            if (!db.objectStoreNames.contains('price_history')) {
                var ph = db.createObjectStore('price_history', { keyPath: 'id' });
                ph.createIndex('release_id', 'release_id');
                ph.createIndex('checked_at', 'checked_at');
            }
            // v10: a max price per want (F9), keyed by release id like `wants`.
            // Authored by the person, so it travels in the backup; removed
            // with the want (removeWantData).
            if (!db.objectStoreNames.contains('want_alerts')) {
                db.createObjectStore('want_alerts', { keyPath: 'id' });
            }
        };
        // Another tab still holds the older version open. The open carries on
        // by itself once that tab closes, so this waits rather than failing,
        // and says what it is waiting for (the view shows "Loading …" meanwhile).
        req.onblocked = function () {
            console.warn('IndexedDB upgrade blocked by another open tab.');
            if (!_dbBlockedToast || !_dbBlockedToast.parentNode) {
                _dbBlockedToast = showToast('Another tab of this app is using an older version of your saved data. ' +
                    'Close it (or reload it), and this tab continues by itself.', 'error', 20000);
            }
        };
        req.onsuccess = function (e) {
            var db = e.target.result;
            _db = db;
            _dbOpening = null;
            _dismissDbBlockedToast();
            // The browser can close the connection itself (storage cleared,
            // disk error); the next call then opens a fresh one. Only this
            // connection: a newer one may have replaced it by then.
            db.onclose = function () { if (_db === db) _db = null; };
            // If another tab opens a newer DB version, close this connection so
            // the upgrade can proceed rather than hanging indefinitely.
            db.onversionchange = function () {
                db.close();
                if (_db === db) _db = null;
                // A blocking alert on purpose (not a toast): the reload below
                // follows at once, and this is the only way to say why.
                alert('The app database was updated in another tab. This tab will now reload.');
                window.location.reload();
            };
            resolve(db);
        };
        req.onerror = function () {
            // Not cached: "Try again" opens afresh.
            _dbOpening = null;
            // The error screen says what went wrong; the "waiting" notice is moot.
            _dismissDbBlockedToast();
            reject(dbOpenError(req.error));
        };
    });
    return _dbOpening;
}

function _dismissDbBlockedToast() {
    if (_dbBlockedToast) { _dismissToast(_dbBlockedToast); _dbBlockedToast = null; }
}

function dbPut(store, item) {
    return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).put(item);
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function (e) { reject(e.target.error); };
        });
    });
}

function dbGet(store, key) {
    return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(store, 'readonly');
            var req = tx.objectStore(store).get(key);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    });
}

function dbGetAll(store) {
    return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(store, 'readonly');
            var req = tx.objectStore(store).getAll();
            req.onsuccess = function () { resolve(req.result || []); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    });
}

function dbGetByIndex(store, indexName, value) {
    return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(store, 'readonly');
            var idx = tx.objectStore(store).index(indexName);
            var req = idx.getAll(value);
            req.onsuccess = function () { resolve(req.result || []); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    });
}

function dbClear(store) {
    return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).clear();
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function (e) { reject(e.target.error); };
        });
    });
}

function dbDelete(store, key) {
    return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).delete(key);
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function (e) { reject(e.target.error); };
        });
    });
}

// Delete every record whose `indexName` equals `value`, in one transaction.
// Resolves to the number deleted.
function dbDeleteByIndex(store, indexName, value) {
    return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(store, 'readwrite');
            var req = tx.objectStore(store).index(indexName).getAllKeys(value);
            var count = 0;
            req.onsuccess = function () {
                var keys = req.result || [];
                count = keys.length;
                keys.forEach(function (k) { tx.objectStore(store).delete(k); });
            };
            tx.oncomplete = function () { resolve(count); };
            tx.onerror = function (e) { reject(e.target.error); };
        });
    });
}
