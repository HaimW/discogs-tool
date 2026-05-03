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
        '<h2 class="backup-card-title">Download backup</h2>' +
        '<p class="backup-card-desc">Exports your setlists, track metadata (BPM, key, rating, notes…) and API config to a JSON file. Collection data is <em>not</em> included — it can always be re-synced from Discogs.</p>' +
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
        '<li><strong>Setlists</strong> &mdash; all playlists with track order and notes</li>' +
        '<li><strong>Track metadata</strong> &mdash; BPM, key, rating, energy, shelf, tags, notes, verified flag</li>' +
        '<li><strong>Config</strong> &mdash; Discogs API token and username</li>' +
        '</ul>' +
        '<h3 style="margin-top:16px">What is NOT included?</h3>' +
        '<ul>' +
        '<li>Collection releases, videos, folders &mdash; re-sync from Discogs with one click after a restore</li>' +
        '</ul>' +
        '</div>' +

        '</div>'; // .backup-page
}

function exportFullBackup() {
    Promise.all([
        dbGetAll('config'),
        dbGetAll('track_meta'),
        dbGetAll('setlists')
    ]).then(function (results) {
        var payload = {
            _version: 1,
            _app: 'VinylCollectionPlayer',
            exported_at: new Date().toISOString(),
            config: results[0],
            track_meta: results[1],
            setlists: results[2]
        };
        var date = new Date().toISOString().slice(0, 10);
        downloadBlob('vinyl-backup-' + date + '.json', 'application/json', JSON.stringify(payload, null, 2));
    });
}

function importBackupFile(input) {
    var file = input.files[0];
    if (!file) return;
    // Reset so the same file can be chosen again
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
        var setlists = backup.setlists || [];
        var metas = backup.track_meta || [];
        var configs = backup.config || [];

        var promises = [];
        configs.forEach(function (rec) { promises.push(dbPut('config', rec)); });
        metas.forEach(function (rec) { promises.push(dbPut('track_meta', rec)); });
        setlists.forEach(function (rec) { promises.push(dbPut('setlists', rec)); });

        Promise.all(promises).then(function () {
            var msg = 'Restored: ' + setlists.length + ' setlist' + (setlists.length === 1 ? '' : 's') +
                ', ' + metas.length + ' track metadata record' + (metas.length === 1 ? '' : 's');
            showSyncBanner(msg);
            setTimeout(hideSyncBanner, 3000);
            renderCurrentView();  // refresh the backup page
        }).catch(function (err) {
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
