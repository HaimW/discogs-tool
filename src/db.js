// ============ IndexedDB Storage ============

var DB_NAME = 'VinylCollectionPlayer';
var DB_VERSION = 7;
var _db = null;

function openDB() {
    return new Promise(function (resolve, reject) {
        if (_db) return resolve(_db);
        var req = indexedDB.open(DB_NAME, DB_VERSION);
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
            if (!db.objectStoreNames.contains('notifications')) {
                var ns = db.createObjectStore('notifications', { keyPath: 'id', autoIncrement: true });
                ns.createIndex('release_id', 'release_id');
                ns.createIndex('seen', 'seen');
                ns.createIndex('created_at', 'created_at');
            }
        };
        req.onblocked = function () {
            console.warn('IndexedDB upgrade blocked by another open tab. Please close other tabs and reload.');
        };
        req.onsuccess = function (e) {
            _db = e.target.result;
            // If another tab opens a newer DB version, close this connection so
            // the upgrade can proceed rather than hanging indefinitely.
            _db.onversionchange = function () {
                _db.close();
                _db = null;
                alert('The app database was updated in another tab. This tab will now reload.');
                window.location.reload();
            };
            resolve(_db);
        };
        req.onerror = function (e) { reject(e.target.error); };
    });
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
