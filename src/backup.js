// ============ Backup / Restore ============

function renderBackup() {
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
        '<p class="backup-card-desc">Exports your entire local database — collection, want list, setlists, track metadata, store inventory and API config — to a single JSON file. Everything needed to fully recover if you clear browser data.</p>' +
        '<button class="btn btn-primary btn-large" onclick="exportFullBackup()">Download vinyl-backup-&lt;date&gt;.json</button>' +
        '</div>' +

        '<div class="backup-card">' +
        '<div class="backup-card-icon">&#8657;</div>' +
        '<h2 class="backup-card-title">Restore from backup</h2>' +
        '<p class="backup-card-desc">Pick a <code>.json</code> file previously downloaded from this page. Records are <em>merged</em> (not wiped) — existing data is kept, backup data is upserted on top. Safe to run twice.</p>' +
        '<button class="btn btn-large" onclick="document.getElementById(\'backup-file-input\').click()">Choose backup file&hellip;</button>' +
        '<input type="file" id="backup-file-input" accept=".json" style="display:none" onchange="importBackupFile(this)">' +
        '</div>' +

        '</div>' + // .backup-grid

        '<div class="backup-legend">' +
        '<h3>What is in the backup?</h3>' +
        '<ul>' +
        '<li><strong>Collection</strong> &mdash; all releases, YouTube videos, folders and track lists</li>' +
        '<li><strong>Want list</strong> &mdash; all wanted releases and their marketplace stats</li>' +
        '<li><strong>Setlists</strong> &mdash; all playlists with track order and notes</li>' +
        '<li><strong>Track metadata</strong> &mdash; BPM, key, rating, energy, shelf, tags, notes, verified flag</li>' +
        '<li><strong>Store</strong> &mdash; serialized inventory items and sale batches</li>' +
        '<li><strong>Config</strong> &mdash; Discogs API token and username</li>' +
        '<li><strong>Notifications</strong> &mdash; marketplace alert history</li>' +
        '</ul>' +
        '</div>' +

        '</div>'; // .backup-page
}

function exportFullBackup() {
    Promise.all([
        dbGetAll('config'),
        dbGetAll('releases'),
        dbGetAll('videos'),
        dbGetAll('folders'),
        dbGetAll('tracklist'),
        dbGetAll('wants'),
        dbGetAll('marketplace_stats'),
        dbGetAll('track_meta'),
        dbGetAll('setlists'),
        dbGetAll('store_items'),
        dbGetAll('store_batches'),
        dbGetAll('notifications')
    ]).then(function (r) {
        var payload = {
            _version: 2,
            _app: 'VinylCollectionPlayer',
            exported_at: new Date().toISOString(),
            config: r[0],
            collection: {
                releases: r[1],
                videos: r[2],
                folders: r[3],
                tracklist: r[4]
            },
            wantlist: {
                wants: r[5],
                marketplace_stats: r[6]
            },
            track_meta: r[7],
            setlists: r[8],
            store: {
                items: r[9],
                batches: r[10]
            },
            notifications: r[11]
        };
        var date = new Date().toISOString().slice(0, 10);
        downloadBlob('vinyl-backup-' + date + '.json', 'application/json', JSON.stringify(payload, null, 2));
    });
}

// Write all records into a store in one transaction (efficient for large sets).
function _bulkPut(storeName, records) {
    if (!records || !records.length) return Promise.resolve(0);
    return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(storeName, 'readwrite');
            var os = tx.objectStore(storeName);
            records.forEach(function (rec) { os.put(rec); });
            tx.oncomplete = function () { resolve(records.length); };
            tx.onerror = function (e) { reject(e.target.error); };
        });
    });
}

function importBackupFile(input) {
    var file = input.files[0];
    if (!file) return;
    input.value = '';
    var reader = new FileReader();
    reader.onload = function (e) {
        var backup;
        try {
            backup = JSON.parse(e.target.result);
        } catch (err) {
            alert('Could not parse backup file: ' + err.message);
            return;
        }
        if (!backup || backup._app !== 'VinylCollectionPlayer') {
            alert('This does not look like a valid Vinyl Collection Player backup file.');
            return;
        }

        showSyncBanner('Restoring backup…');

        var v = backup._version || 1;
        var col = backup.collection || {};
        var wl  = backup.wantlist  || {};
        var st  = backup.store     || {};

        Promise.all([
            _bulkPut('config',            backup.config          || []),
            _bulkPut('track_meta',        backup.track_meta      || []),
            _bulkPut('setlists',          backup.setlists        || []),
            _bulkPut('releases',          col.releases           || []),
            _bulkPut('videos',            col.videos             || []),
            _bulkPut('folders',           col.folders            || []),
            _bulkPut('tracklist',         col.tracklist          || []),
            _bulkPut('wants',             wl.wants               || []),
            _bulkPut('marketplace_stats', wl.marketplace_stats   || []),
            _bulkPut('store_items',       st.items               || []),
            _bulkPut('store_batches',     st.batches             || []),
            _bulkPut('notifications',     backup.notifications   || [])
        ]).then(function (counts) {
            var parts = [];
            if (counts[3])  parts.push(counts[3]  + ' releases');
            if (counts[4])  parts.push(counts[4]  + ' videos');
            if (counts[7])  parts.push(counts[7]  + ' want list items');
            if (counts[2])  parts.push(counts[2]  + ' setlist' + (counts[2] === 1 ? '' : 's'));
            if (counts[1])  parts.push(counts[1]  + ' track metadata record' + (counts[1] === 1 ? '' : 's'));
            if (counts[9])  parts.push(counts[9]  + ' store item' + (counts[9] === 1 ? '' : 's'));
            if (counts[10]) parts.push(counts[10] + ' store batch' + (counts[10] === 1 ? '' : 'es'));
            var msg = 'Restored' + (v > 1 ? ' (v' + v + ')' : '') + ': ' +
                (parts.length ? parts.join(', ') : 'nothing to restore');
            showSyncBanner(msg);
            setTimeout(hideSyncBanner, 5000);
            renderCurrentView();
        }).catch(function (err) {
            hideSyncBanner();
            alert('Restore failed: ' + err.message);
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
