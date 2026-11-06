// ============ Backup / Restore ============

function renderBackup() {
    startViewRender();
    var app = document.getElementById('app');
    app.innerHTML =
        '<div class="backup-page">' +
        '<div class="collection-header"><div class="collection-stats"><h1>Backup &amp; Restore</h1></div></div>' +

        '<div class="backup-warning">' +
        '<span class="backup-warning-icon">&#9888;</span>' +
        '<div>' +
        '<strong>Your data lives only in this browser\'s IndexedDB.</strong> ' +
        'It will be lost if you clear site data, reinstall the browser, switch browsers, or change how you serve the app (e.g. <code>file://</code> vs <code>localhost</code>). ' +
        'Download a backup regularly and keep it somewhere safe.' +
        '</div></div>' +

        '<div class="backup-grid">' +

        '<div class="backup-card">' +
        '<div class="backup-card-icon">&#8659;</div>' +
        '<h2 class="backup-card-title">Download full backup</h2>' +
        '<p class="backup-card-desc">Exports everything you have entered or built up here — track metadata, setlists, store inventory, max-price alerts, price history, alert history — plus a copy of your collection and want list, to a single JSON file. Your Discogs token is <em>not</em> included: after restoring into a fresh browser, enter it again on Setup.</p>' +
        '<button class="btn btn-primary btn-large"' + act('click', 'exportFullBackup') + '>Download vinyl-backup-&lt;date&gt;.json</button>' +
        '</div>' +

        '<div class="backup-card">' +
        '<div class="backup-card-icon">&#8657;</div>' +
        '<h2 class="backup-card-title">Restore from backup</h2>' +
        '<p class="backup-card-desc">Pick a <code>.json</code> file previously downloaded from this page (any version), or an <code>analysis.json</code> from the desktop analyzer. Records are <em>merged</em> (not wiped) — existing data is kept, backup data is upserted on top. Safe to run twice.</p>' +
        '<button class="btn btn-large"' + act('click', 'backupChooseFile') + '>Choose backup file&hellip;</button>' +
        '<input type="file" id="backup-file-input" accept=".json" style="display:none"' + act('change', 'importBackupFile', [ACT_THIS]) + '>' +
        '</div>' +

        '</div>' + // .backup-grid

        '<div class="backup-legend">' +
        '<h3>What is in the backup?</h3>' +
        '<p><strong>Authored</strong> &mdash; what you typed or what built up in this browser. Discogs cannot give it back, so this is what the backup is for:</p>' +
        '<ul>' +
        '<li><strong>Track metadata</strong> &mdash; BPM, key, rating, energy, shelf, tags, notes, verified flag</li>' +
        '<li><strong>Setlists</strong> &mdash; all playlists with track order and notes</li>' +
        '<li><strong>Store</strong> &mdash; serialized inventory items and sale batches</li>' +
        '<li><strong>Max-price alerts</strong> &mdash; the max price and currency you set per want</li>' +
        '<li><strong>Price history</strong> &mdash; marketplace readings recorded over time</li>' +
        '<li><strong>Notifications</strong> &mdash; marketplace alert history</li>' +
        '<li><strong>Config</strong> &mdash; your Discogs username, crossfade and volume settings (the token is never exported)</li>' +
        '</ul>' +
        '<p><strong>Derived</strong> &mdash; copies of what Discogs has, so a restore works offline; a sync would fetch them again:</p>' +
        '<ul>' +
        '<li><strong>Collection</strong> &mdash; releases (with your video picks), YouTube videos, folders and track lists</li>' +
        '<li><strong>Want list</strong> &mdash; wanted releases and their latest marketplace stats</li>' +
        '</ul>' +
        '</div>' +

        '</div>'; // .backup-page
}

// Config keys a backup may carry: settings the person chose. The Discogs token
// is a credential: it is left out so a backup file is safe to keep in a cloud
// folder. collection_value is a cached Discogs reading, also left out.
var EXPORT_CONFIG_KEYS = ['discogs_username', 'crossfade_enabled', 'crossfade_seconds',
    'player_volume', 'player_muted'];

// Config values a restore checks before writing them; a record that fails is
// left out, so the setting already in this browser stays.
var CONFIG_RESTORE_CHECKS = {
    player_volume: function (v) { return Number.isInteger(v) && v >= 0 && v <= 100; },
    player_muted: function (v) { return typeof v === 'boolean'; }
};

// Every store a full backup reads.
var BACKUP_STORES = ['config', 'releases', 'videos', 'folders', 'tracklist', 'wants',
    'marketplace_stats', 'track_meta', 'setlists', 'store_items', 'store_batches',
    'notifications', 'price_history', 'want_alerts'];

// The v3 backup document from the stores' records (`stores` maps a store name
// to its records). Authored data — which cannot be fetched from Discogs again —
// is kept apart from derived data. `track_meta` and `collection` stay at their
// v2 paths because desktop-analyzer reads them there.
function buildBackupPayload(stores, nowIso) {
    function all(name) { return stores[name] || []; }
    return {
        _version: 3,
        _app: 'VinylCollectionPlayer',
        exported_at: nowIso,
        _contents: {
            note: 'Authored sections hold what you entered or what built up in this browser; ' +
                'Discogs cannot return them. Derived sections are copies of Discogs data that a sync ' +
                'fetches again. track_meta and collection stay at their v2 paths for desktop-analyzer. ' +
                'The Discogs token is not included.',
            sections: {
                'track_meta': 'authored',
                'authored.setlists': 'authored',
                'authored.store': 'authored',
                'authored.price_history': 'authored',
                'authored.notifications': 'authored',
                'authored.want_alerts': 'authored',
                'authored.config': 'authored',
                'collection': 'derived (releases also carry your video_overrides)',
                'derived.wants': 'derived',
                'derived.marketplace_stats': 'derived'
            },
            pinned_v2_paths: ['track_meta', 'collection']
        },
        track_meta: all('track_meta'),
        authored: {
            setlists: all('setlists'),
            store: { items: all('store_items'), batches: all('store_batches') },
            price_history: all('price_history'),
            notifications: all('notifications'),
            want_alerts: all('want_alerts'),
            config: all('config').filter(function (c) {
                return c && EXPORT_CONFIG_KEYS.indexOf(c.key) !== -1;
            })
        },
        collection: {
            releases: all('releases'),
            videos: all('videos'),
            folders: all('folders'),
            tracklist: all('tracklist')
        },
        derived: {
            wants: all('wants'),
            marketplace_stats: all('marketplace_stats')
        }
    };
}

function exportFullBackup() {
    return Promise.all(BACKUP_STORES.map(function (name) { return dbGetAll(name); })).then(function (r) {
        var stores = {};
        BACKUP_STORES.forEach(function (name, i) { stores[name] = r[i]; });
        var now = new Date().toISOString();
        var payload = buildBackupPayload(stores, now);
        downloadBlob('vinyl-backup-' + now.slice(0, 10) + '.json', 'application/json', JSON.stringify(payload, null, 2));
    }).catch(function (err) {
        showToast('Backup failed: ' + err.message, 'error');
    });
}

// Write all records into a store in one transaction (efficient for large sets).
function _bulkPut(storeName, records) {
    if (!records || !records.length) return Promise.resolve(0);
    return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(storeName, 'readwrite');
            var os = tx.objectStore(storeName);
            tx.oncomplete = function () { resolve(records.length); };
            tx.onerror = function (e) { reject(e.target.error); };
            tx.onabort = function () { reject(tx.error || new Error('Writing ' + storeName + ' was aborted')); };
            try {
                records.forEach(function (rec) { os.put(rec); });
            } catch (err) {
                // A put that throws (bad key) must not leave half the records written.
                try { tx.abort(); } catch (e) { /* already finished */ }
                reject(err);
            }
        });
    });
}

// Marketplace readings from a backup (M5). A local reading is newer than any
// backup's, so it is kept. A backup's reading fills a gap for display, but is
// flagged so the next poll records a fresh baseline instead of comparing
// against an old count: an alert needs a 0 -> 1+ change this browser saw.
function _restoreMarketplaceStats(records) {
    if (!records.length) return Promise.resolve(0);
    return dbGetAll('marketplace_stats').then(function (local) {
        var have = {};
        local.forEach(function (s) { have[s.id] = true; });
        var fresh = records.filter(function (r) { return r && !have[r.id]; }).map(function (r) {
            var copy = Object.assign({}, r);
            copy.baseline_restored = true;
            copy.checked_at = null; // due for a check at the next poll
            return copy;
        });
        return _bulkPut('marketplace_stats', fresh);
    });
}

function backupChooseFile() {
    document.getElementById('backup-file-input').click();
}

// Any backup file — v1, v2, v3, or desktop-analyzer's analysis.json (a v2-
// shaped file carrying only track_meta) — as flat record lists per store, or
// null when it is not one of ours. Sections are found by path, not by
// `_version`, so a file missing a section simply restores nothing for it.
// The key each store's records are written under (src/db.js keyPaths). Stores
// with autoIncrement are listed as optional: a record without an id gets a new
// one, so only a present-but-invalid id is a reason to drop it.
var BACKUP_STORE_KEYS = {
    config: { path: 'key' },
    releases: { path: 'id' }, folders: { path: 'id' }, tracklist: { path: 'id' },
    track_meta: { path: 'id' }, wants: { path: 'id' }, marketplace_stats: { path: 'id' },
    store_items: { path: 'id' }, price_history: { path: 'id' }, want_alerts: { path: 'id' },
    videos: { path: 'id', optional: true }, setlists: { path: 'id', optional: true },
    store_batches: { path: 'id', optional: true }, notifications: { path: 'id', optional: true }
};

function _validBackupKey(v) {
    return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

function _normalizeBackup(raw) {
    if (!raw || typeof raw !== 'object' || raw._app !== 'VinylCollectionPlayer') return null;
    function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    function rows(v) {
        return Array.isArray(v) ? v.filter(function (r) { return r && typeof r === 'object' && !Array.isArray(r); }) : [];
    }
    function pick(a, b) { return Array.isArray(a) ? a : b; }
    var authored = obj(raw.authored);
    var derived = obj(raw.derived);
    var col = obj(raw.collection);
    var wl = obj(raw.wantlist);                   // v1/v2
    var st = obj(authored.store || raw.store);   // v3 / v1-v2
    // Records a put would reject (no key, or a key IndexedDB cannot use).
    function keyed(store, v) {
        var k = BACKUP_STORE_KEYS[store];
        return rows(v).filter(function (r) {
            var key = r[k.path];
            if (key === undefined && k.optional) return true;
            return _validBackupKey(key);
        });
    }
    return {
        version: typeof raw._version === 'number' ? raw._version : 1,
        config: keyed('config', pick(authored.config, raw.config)),
        track_meta: keyed('track_meta', raw.track_meta),
        setlists: keyed('setlists', pick(authored.setlists, raw.setlists)),
        store_items: keyed('store_items', st.items),
        store_batches: keyed('store_batches', st.batches),
        price_history: keyed('price_history', pick(authored.price_history, wl.price_history)),
        notifications: keyed('notifications', pick(authored.notifications, raw.notifications)),
        want_alerts: keyed('want_alerts', pick(authored.want_alerts, raw.want_alerts)),
        releases: keyed('releases', col.releases),
        videos: keyed('videos', col.videos),
        folders: keyed('folders', col.folders),
        tracklist: keyed('tracklist', col.tracklist),
        wants: keyed('wants', pick(derived.wants, wl.wants)),
        marketplace_stats: keyed('marketplace_stats', pick(derived.marketplace_stats, wl.marketplace_stats))
    };
}

// Which config records to write. A restore never repoints an existing login:
// - a token from an older backup is only used when this browser has none;
// - the file's username goes with the file's token when that is restored;
// - otherwise the file's username is used only when this browser has neither a
//   token nor a username (a fresh browser), and the local one is kept.
// tokenOutcome: null (the file carried none), 'restored' or 'kept'.
function _configToRestore(records, localToken, localUsername) {
    var token = null;
    var username = null;
    var rest = records.filter(function (c) {
        var check = Object.prototype.hasOwnProperty.call(CONFIG_RESTORE_CHECKS, c.key) && CONFIG_RESTORE_CHECKS[c.key];
        if (check && !check(c.value)) return false;
        if (c.key === 'discogs_username') {
            if (c.value) username = c;
            return false;
        }
        if (c.key !== 'discogs_token') return true;
        if (c.value) token = c;
        return false;
    });
    var tokenOutcome = !token ? null : localToken ? 'kept' : 'restored';
    if (tokenOutcome === 'restored') rest.push(token);
    var takeUsername = tokenOutcome === 'restored' || (!localToken && !localUsername);
    if (username && takeUsername) rest.push(username);
    return { records: rest, tokenOutcome: tokenOutcome };
}

// Fields only this browser fills in (the person's video picks, details from
// the per-release fetch). A backup record without them does not erase them.
var RELEASE_LOCAL_FIELDS = ['video_overrides', 'country', 'community_have', 'community_want', 'community_fetched_at'];
var RELEASE_COMMUNITY_FIELDS = ['community_have', 'community_want', 'community_fetched_at'];

function _plainObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }

// Backup releases laid over the local ones, field by field.
function _mergeReleases(backupRecords, localRecords) {
    var local = {};
    localRecords.forEach(function (r) { local[r.id] = r; });
    return backupRecords.map(function (rec) {
        var mine = local[rec.id];
        if (!mine) return rec;
        var merged = Object.assign({}, mine, rec);
        RELEASE_LOCAL_FIELDS.forEach(function (f) {
            if (merged[f] == null && mine[f] != null) merged[f] = mine[f];
        });
        // Community counts are a reading at a time: the newer reading wins.
        var mineAt = dateMs(mine.community_fetched_at);
        var fileAt = dateMs(rec.community_fetched_at);
        if (mineAt !== null && (fileAt === null || mineAt > fileAt)) {
            RELEASE_COMMUNITY_FIELDS.forEach(function (f) { merged[f] = mine[f]; });
        }
        // Video picks from both, the ones made in this browser winning.
        var fileVo = _plainObject(rec.video_overrides);
        var mineVo = _plainObject(mine.video_overrides);
        if (fileVo || mineVo) merged.video_overrides = Object.assign({}, fileVo, mineVo);
        return merged;
    });
}

// Writes a normalized backup (see _normalizeBackup) into the stores. Resolves
// to { counts: {store: n}, tokenOutcome }.
async function restoreBackup(b) {
    if (_syncRunning) throw new Error('a sync is running. Try again when it has finished.');
    var localToken = await dbGet('config', 'discogs_token');
    var localUsername = await dbGet('config', 'discogs_username');
    var cfg = _configToRestore(b.config, localToken && localToken.value, localUsername && localUsername.value);
    var releases = b.releases.length ? _mergeReleases(b.releases, await dbGetAll('releases')) : [];

    var names = ['config', 'track_meta', 'setlists', 'releases', 'videos', 'folders', 'tracklist',
        'wants', 'marketplace_stats', 'store_items', 'store_batches', 'notifications', 'price_history'];
    var results = await Promise.all([
        _bulkPut('config', cfg.records),
        _bulkPut('track_meta', b.track_meta),
        _bulkPut('setlists', b.setlists),
        _bulkPut('releases', releases),
        _bulkPut('videos', b.videos),
        _bulkPut('folders', b.folders),
        _bulkPut('tracklist', b.tracklist),
        _bulkPut('wants', b.wants),
        _restoreMarketplaceStats(b.marketplace_stats),
        _bulkPut('store_items', b.store_items),
        _bulkPut('store_batches', b.store_batches),
        _bulkPut('notifications', b.notifications),
        _bulkPut('price_history', b.price_history)
    ]);
    var counts = {};
    names.forEach(function (n, i) { counts[n] = results[i]; });

    // After the wants, so an alert for a want neither here nor in the file
    // (an orphan) is dropped rather than kept with nothing to watch.
    var wantIds = {};
    (await dbGetAll('wants')).forEach(function (w) { wantIds[w.id] = true; });
    counts.want_alerts = await _bulkPut('want_alerts', b.want_alerts.filter(function (a) { return wantIds[a.id]; }));

    return { counts: counts, tokenOutcome: cfg.tokenOutcome };
}

// The toast after a restore.
function _restoreMessage(version, counts, tokenOutcome) {
    function n(count, one, many) { return count + ' ' + (count === 1 ? one : many); }
    var parts = [];
    if (counts.releases)          parts.push(counts.releases + ' releases');
    if (counts.videos)            parts.push(counts.videos + ' videos');
    if (counts.wants)             parts.push(counts.wants + ' want list items');
    if (counts.setlists)          parts.push(n(counts.setlists, 'setlist', 'setlists'));
    if (counts.track_meta)        parts.push(n(counts.track_meta, 'track metadata record', 'track metadata records'));
    if (counts.store_items)       parts.push(n(counts.store_items, 'store item', 'store items'));
    if (counts.store_batches)     parts.push(n(counts.store_batches, 'store batch', 'store batches'));
    if (counts.price_history)     parts.push(n(counts.price_history, 'price reading', 'price readings'));
    if (counts.want_alerts)       parts.push(n(counts.want_alerts, 'max-price alert', 'max-price alerts'));
    var msg = 'Restored' + (version > 1 ? ' (v' + version + ')' : '') + ': ' +
        (parts.length ? parts.join(', ') : 'nothing to restore');
    if (tokenOutcome === 'restored') msg += '. Discogs token restored from the file.';
    else if (tokenOutcome === 'kept') msg += '. Kept your current Discogs token.';
    return msg;
}

var RESTORE_WHILE_SYNCING = 'A sync is running. Restore when it has finished.';

function importBackupFile(input) {
    var file = input.files[0];
    if (!file) return;
    input.value = '';
    if (_syncRunning) {
        showToast(RESTORE_WHILE_SYNCING, 'error');
        return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
        var raw;
        try {
            raw = JSON.parse(e.target.result);
        } catch (err) {
            showToast('Could not read the backup file: ' + err.message, 'error');
            return;
        }
        var backup = _normalizeBackup(raw);
        if (!backup) {
            showToast('This does not look like a Vinyl Collection Player backup file.', 'error');
            return;
        }
        if (_syncRunning) {  // a sync started while the file was read
            showToast(RESTORE_WHILE_SYNCING, 'error');
            return;
        }

        showSyncBanner('Restoring backup…');
        restoreBackup(backup).then(function (res) {
            hideSyncBanner();
            showToast(_restoreMessage(backup.version, res.counts, res.tokenOutcome), 'success', 6000);
            renderCurrentView();
        }).catch(function (err) {
            hideSyncBanner();
            showToast('Restore failed: ' + err.message, 'error');
        });
    };
    reader.readAsText(file);
}

function exportSetlistM3U(id) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl) return;
        var lines = ['#EXTM3U'];
        (sl.tracks || []).forEach(function (t) {
            var label = (t.artist ? t.artist + ' - ' : '') + t.title;
            lines.push('#EXTINF:-1,' + label);
            lines.push('https://www.youtube.com/watch?v=' + t.youtubeId);
        });
        downloadBlob(slugifySetlist(sl.name) + '.m3u', 'audio/x-mpegurl', lines.join('\n') + '\n');
    });
}

function exportSetlistTxt(id) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl) return;
        var lines = (sl.tracks || []).map(function (t, i) {
            return (i + 1) + '. ' + (t.artist ? t.artist + ' - ' : '') + t.title;
        });
        downloadBlob(slugifySetlist(sl.name) + '.txt', 'text/plain', lines.join('\n') + '\n');
    });
}

function exportSetlistCsv(id) {
    Promise.all([dbGet('setlists', id), dbGetAll('track_meta')]).then(function (results) {
        var sl = results[0];
        if (!sl) return;
        var metaById = {};
        results[1].forEach(function (m) { metaById[m.id] = m; });
        var lines = ['order,artist,title,release_id,youtube_id,youtube_url,bpm,key,rating'];
        (sl.tracks || []).forEach(function (t, i) {
            var m = metaById[t.metaId] || {};
            lines.push([
                i + 1,
                _csvCell(t.artist || ''),
                _csvCell(t.title || ''),
                t.releaseId || '',
                t.youtubeId,
                'https://www.youtube.com/watch?v=' + t.youtubeId,
                m.bpm != null ? m.bpm : '',
                m.key || '',
                m.rating || ''
            ].join(','));
        });
        downloadBlob(slugifySetlist(sl.name) + '.csv', 'text/csv', lines.join('\n') + '\n');
    });
}

function _csvCell(s) {
    s = String(s == null ? '' : s);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}
