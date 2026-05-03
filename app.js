/* ================================================
   Vinyl Collection Player v2 — Pure client-side SPA
   IndexedDB storage, Discogs API, YouTube player
   ================================================ */

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
        req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
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

// ============ Track Metadata Helpers ============

function trackMetaId(releaseId, youtubeId) {
    return releaseId + '_' + youtubeId;
}

function getTrackMeta(id) {
    return dbGet('track_meta', id);
}

function saveTrackMeta(id, patch) {
    return getTrackMeta(id).then(function (existing) {
        var rec = existing || { id: id };
        for (var k in patch) rec[k] = patch[k];
        rec.updated_at = new Date().toISOString();
        return dbPut('track_meta', rec);
    });
}

function ratingStars(n) {
    n = Math.max(0, Math.min(5, parseInt(n, 10) || 0));
    var out = '';
    for (var i = 0; i < n; i++) out += '\u2605';
    for (var j = n; j < 5; j++) out += '\u2606';
    return out;
}

// ============ Config Helpers ============

function getConfig() {
    return Promise.all([
        dbGet('config', 'discogs_token'),
        dbGet('config', 'discogs_username')
    ]).then(function (results) {
        return {
            token: results[0] ? results[0].value : '',
            username: results[1] ? results[1].value : ''
        };
    });
}

function saveConfig(token, username) {
    return Promise.all([
        dbPut('config', { key: 'discogs_token', value: token.trim() }),
        dbPut('config', { key: 'discogs_username', value: username.trim() })
    ]);
}

function isConfigured() {
    return getConfig().then(function (c) { return !!(c.token && c.username); });
}

// ============ Discogs API ============

async function discogsGet(path, config, _retries) {
    if (_retries === undefined) _retries = 3;
    var headers = {
        'Authorization': 'Discogs token=' + config.token,
        'User-Agent': 'VinylCollectionPlayer/2.0'
    };
    var r;
    try {
        r = await fetch('https://api.discogs.com' + path, { headers: headers });
    } catch (err) {
        // Network error or CORS block (429 without CORS headers shows up here)
        if (_retries <= 0) throw err;
        var backoff = (4 - _retries) * 15;
        console.warn('Request failed on ' + path + ', backing off ' + backoff + 's (retries left: ' + (_retries - 1) + ')');
        showSyncBanner('Rate limited — waiting ' + backoff + 's...');
        await sleep(backoff * 1000);
        return discogsGet(path, config, _retries - 1);
    }

    // Explicit 429
    if (r.status === 429) {
        if (_retries <= 0) throw new Error('Rate limited after retries');
        var wait = parseInt(r.headers.get('Retry-After') || '30') * 1000;
        console.warn('429 on ' + path + ', waiting ' + (wait / 1000) + 's...');
        showSyncBanner('Rate limited — waiting ' + (wait / 1000) + 's...');
        await sleep(wait);
        return discogsGet(path, config, _retries - 1);
    }

    if (!r.ok) throw new Error('Discogs API ' + r.status + ' on ' + path);

    // Proactive back-off when close to limit
    var remaining = r.headers.get('X-Discogs-Ratelimit-Remaining');
    if (remaining !== null && parseInt(remaining) < 5) {
        console.warn('Rate limit low (' + remaining + '), sleeping 10s...');
        showSyncBanner('Rate limit low, pausing 10s...');
        await sleep(10000);
    }

    return r.json();
}

var _syncRunning = false;

function startSync() {
    if (_syncRunning) return;
    getConfig().then(function (config) {
        if (!config.token || !config.username) {
            navigate('setup');
            return;
        }
        _syncRunning = true;
        document.getElementById('sync-btn').disabled = true;
        showSyncBanner('Starting sync...');
        // Phase 0 + 1: fetch folders and release metadata. Blocking — we need
        // this before the user can browse anything.
        syncCollection(config).then(function () {
            // Jump to the collection immediately so the user can browse while
            // Phase 2 (video fetching) runs in the background.
            navigate('collection');
            showSyncBanner('Collection ready — fetching videos in background...');
            // Fire and forget: syncVideosInBackground() manages its own banner,
            // _syncRunning flag, and sync button state when it finishes.
            syncVideosInBackground(config).catch(function (err) {
                showSyncBanner('Video sync failed: ' + err.message);
                console.error(err);
                _syncRunning = false;
                document.getElementById('sync-btn').disabled = false;
            });
        }).catch(function (err) {
            showSyncBanner('Sync failed: ' + err.message);
            console.error(err);
            _syncRunning = false;
            document.getElementById('sync-btn').disabled = false;
        });
    });
}

function showSyncBanner(msg) {
    document.getElementById('sync-banner').style.display = 'flex';
    document.getElementById('sync-message').textContent = msg;
}

function hideSyncBanner() {
    document.getElementById('sync-banner').style.display = 'none';
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function syncCollection(config) {
    // Phase 0: Fetch folders
    showSyncBanner('Fetching folders...');
    var foldersData = await discogsGet('/users/' + config.username + '/collection/folders', config);
    var folders = (foldersData.folders || []);
    for (var i = 0; i < folders.length; i++) {
        await dbPut('folders', { id: folders[i].id, name: folders[i].name, count: folders[i].count || 0 });
    }

    // Phase 1: Fetch releases per folder
    showSyncBanner('Fetching collection...');
    var realFolders = folders.filter(function (f) { return f.id !== 0; });
    var allReleases = {};

    for (var fi = 0; fi < realFolders.length; fi++) {
        showSyncBanner('Fetching folder: ' + realFolders[fi].name + '...');
        await fetchFolderReleases(config, realFolders[fi].id, allReleases, realFolders[fi].id);
    }
    // Catch-up pass against folder 0 ("All") to pick up unfiled releases.
    // skipDuplicates=true prevents the quantity++ branch from firing for
    // releases already captured from a custom folder — folder 0 returns
    // the entire collection, so without this every quantity would inflate by 1.
    await fetchFolderReleases(config, 0, allReleases, null, true);

    // Save releases to IndexedDB — preserve synced_at and video_count
    // from existing records so a re-sync doesn't wipe previous video data.
    var ids = Object.keys(allReleases);
    showSyncBanner('Saving ' + ids.length + ' releases...');
    for (var ri = 0; ri < ids.length; ri++) {
        var newRel = allReleases[ids[ri]];
        var existing = await dbGet('releases', newRel.id);
        if (existing) {
            newRel.synced_at = existing.synced_at;
            newRel.video_count = existing.video_count || 0;
        }
        await dbPut('releases', newRel);
    }

    // Remove releases that are no longer in the Discogs collection.
    var existingReleases = await dbGetAll('releases');
    for (var ei = 0; ei < existingReleases.length; ei++) {
        var eid = existingReleases[ei].id;
        if (!allReleases[eid]) {
            await dbDelete('releases', eid);
            var staleVideos = await dbGetByIndex('videos', 'release_id', eid);
            for (var vi2 = 0; vi2 < staleVideos.length; vi2++) {
                await dbDelete('videos', staleVideos[vi2].id);
            }
            var staleTracks = await dbGetByIndex('tracklist', 'release_id', eid);
            for (var ti2 = 0; ti2 < staleTracks.length; ti2++) {
                await dbDelete('tracklist', staleTracks[ti2].id);
            }
            var staleMeta = await dbGetByIndex('track_meta', 'release_id', eid);
            for (var mi = 0; mi < staleMeta.length; mi++) {
                await dbDelete('track_meta', staleMeta[mi].id);
            }
        }
    }
}

// Phase 2 runs in the background so the user can browse the collection
// while videos trickle in. Called from startSync() after syncCollection()
// resolves. Not awaited — it updates the banner independently.
async function syncVideosInBackground(config) {
    var releases = await dbGetAll('releases');
    var unsynced = releases.filter(function (r) { return !r.synced_at; });
    var total = unsynced.length;
    if (total === 0) {
        hideSyncBanner();
        _syncRunning = false;
        document.getElementById('sync-btn').disabled = false;
        return;
    }

    var startTime = Date.now();
    var rerenderEvery = 5; // re-render collection every N releases so new videos appear

    for (var vi = 0; vi < unsynced.length; vi++) {
        var rel = unsynced[vi];
        var done = vi + 1;
        var elapsed = (Date.now() - startTime) / 1000;
        var avg = done > 1 ? elapsed / (done - 1) : 1.2;
        var remaining = Math.max(0, Math.round(avg * (total - done)));
        var etaStr = formatEta(remaining);
        showSyncBanner('Fetching videos: ' + done + '/' + total +
                       ' (ETA ' + etaStr + ') - ' + rel.artist + ' - ' + rel.title);

        try {
            var data = await discogsGet('/releases/' + rel.id, config);
            var videos = (data.videos || []);
            var vidCount = 0;
            for (var v = 0; v < videos.length; v++) {
                var vid = videos[v];
                if (!vid.embed) continue;
                var uri = vid.uri || '';
                if (uri.indexOf('youtube.com') === -1 && uri.indexOf('youtu.be') === -1) continue;
                var ytId = extractYoutubeId(uri);
                if (!ytId) continue;
                await dbPut('videos', {
                    id: rel.id + '_' + ytId,
                    release_id: rel.id,
                    title: vid.title || 'Untitled',
                    uri: uri,
                    youtube_id: ytId,
                    duration: vid.duration || null,
                    position: v + 1
                });
                vidCount++;
            }
            rel.video_count = vidCount;
            rel.synced_at = new Date().toISOString();
            rel.country = data.country || rel.country || null;

            var tracklistData = data.tracklist || [];
            for (var ti = 0; ti < tracklistData.length; ti++) {
                var tl = tracklistData[ti];
                await dbPut('tracklist', {
                    id: rel.id + '_' + ti,
                    release_id: rel.id,
                    position: tl.position || '',
                    title: tl.title || '',
                    duration: tl.duration || '',
                    type: tl.type_ || 'track',
                    index: ti
                });
            }
            rel.tracklist_synced = true;
            await dbPut('releases', rel);
        } catch (err) {
            console.error('Error fetching release ' + rel.id + ':', err);
        }

        // Re-render collection periodically so new video counts show up
        // while the user browses. Only if they're on the collection view.
        if (done % rerenderEvery === 0 && _currentView === 'collection') {
            renderCollection();
        }

        // Pace Phase 2: each request with Authorization header triggers CORS
        // preflight (OPTIONS + GET = 2 HTTP calls). 1.1s gap keeps us just
        // under the 60 req/min Discogs limit with a small safety margin.
        if (vi < unsynced.length - 1) await sleep(1100);
    }

    showSyncBanner('Sync complete!');
    if (_currentView === 'collection') renderCollection();
    setTimeout(function () { hideSyncBanner(); }, 2000);
    _syncRunning = false;
    document.getElementById('sync-btn').disabled = false;
}

function formatEta(seconds) {
    if (seconds < 60) return seconds + 's';
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + 'm ' + s + 's';
}

async function fetchFolderReleases(config, folderId, allReleases, tagFolderId, skipDuplicates) {
    var page = 1;
    while (true) {
        var path = '/users/' + config.username + '/collection/folders/' + folderId + '/releases?per_page=100&page=' + page;
        var data = await discogsGet(path, config);
        var items = data.releases || [];

        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var info = item.basic_information || {};
            var rid = info.id;
            if (!allReleases[rid]) {
                allReleases[rid] = {
                    id: rid,
                    title: info.title || 'Unknown',
                    artist: (info.artists || []).map(function (a) { return a.name; }).join(', ') || 'Unknown',
                    year: info.year || null,
                    genres: (info.genres || []).join(', ') || null,
                    styles: (info.styles || []).join(', ') || null,
                    thumb_url: info.thumb || null,
                    cover_url: info.cover_image || null,
                    format: (info.formats || []).map(function (f) { return f.name; }).join(', ') || null,
                    quantity: 1,
                    date_added: item.date_added || null,
                    synced_at: null,
                    video_count: 0,
                    folder_ids: [],
                    country: null
                };
            } else if (!skipDuplicates) {
                allReleases[rid].quantity++;
            }
            if (tagFolderId && allReleases[rid].folder_ids.indexOf(tagFolderId) === -1) {
                allReleases[rid].folder_ids.push(tagFolderId);
            }
        }

        var pagination = data.pagination || {};
        var totalPages = pagination.pages || 1;
        showSyncBanner('  page ' + page + '/' + totalPages);

        if (page >= totalPages) break;
        page++;
        await sleep(1000);
    }
}

function extractYoutubeId(uri) {
    try {
        var url = new URL(uri);
        if (url.hostname.indexOf('youtube.com') !== -1) {
            var v = url.searchParams.get('v');
            if (v) return v;
            // Handle /shorts/{id}, /embed/{id}, /live/{id}, /v/{id}
            var m = url.pathname.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
            if (m) return m[2];
        }
        if (url.hostname.indexOf('youtu.be') !== -1) {
            return url.pathname.slice(1).split('?')[0] || null;
        }
    } catch (e) {}
    return null;
}

// ============ SPA Router ============

var _currentView = '';
var _filters = {
    q: '', genre: '', folder: '', country: '', sort: 'artist', page: 1,
    tracks: { q: '', bpmMin: '', bpmMax: '', key: '', minRating: 0, tag: '', sort: 'artist', page: 1 },
    setlistId: null,
    wantlist: { q: '', genre: '', format: '', decade: '', country: '', sort: 'artist', page: 1 }
};
var _navHistory = [];
var _navFromPop = false;

function navigate(view, params) {
    if (_currentView && !_navFromPop) {
        _navHistory.push({ view: _currentView, filters: JSON.parse(JSON.stringify(_filters)) });
        history.pushState(null, '');
    }
    _currentView = view;
    if (params) {
        for (var k in params) _filters[k] = params[k];
    }
    renderCurrentView();
    window.scrollTo(0, 0);
}

function renderCurrentView() {
    isConfigured().then(function (configured) {
        if (!configured && _currentView !== 'setup') {
            _currentView = 'setup';
        }
        switch (_currentView) {
            case 'setup': renderSetup(); break;
            case 'release': renderRelease(_filters.releaseId); break;
            case 'tracks': renderTracks(); break;
            case 'wantlist': renderWantList(); break;
            case 'setlists': renderSetlists(); break;
            case 'setlist': renderSetlist(_filters.setlistId); break;
            case 'backup': renderBackup(); break;
            default: renderCollection(); break;
        }
    });
}

// ============ Setup View ============

function renderSetup() {
    getConfig().then(function (config) {
        var app = document.getElementById('app');
        app.innerHTML =
            '<div class="setup-page"><div class="setup-card">' +
            '<div class="vinyl-icon-huge">&#9898;</div>' +
            '<h1 class="setup-title">Welcome to Vinyl Collection Player</h1>' +
            '<p class="setup-subtitle">Connect your Discogs account to get started</p>' +
            '<div class="setup-form">' +
            '<div class="form-group">' +
            '<label class="form-label" for="username">Discogs Username</label>' +
            '<input type="text" id="setup-username" class="form-input" placeholder="e.g. yafim.sh" value="' + escHtml(config.username) + '">' +
            '</div>' +
            '<div class="form-group">' +
            '<label class="form-label" for="token">Personal Access Token</label>' +
            '<input type="text" id="setup-token" class="form-input" placeholder="Paste your token here" value="' + escHtml(config.token) + '">' +
            '<p class="form-hint">Generate a token at <a href="https://www.discogs.com/settings/developers" target="_blank" rel="noopener">Discogs Developer Settings</a></p>' +
            '</div>' +
            '<button class="btn btn-primary btn-large btn-full" onclick="submitSetup()">Save &amp; Continue</button>' +
            '</div></div></div>';
    });
}

function submitSetup() {
    var token = document.getElementById('setup-token').value.trim();
    var username = document.getElementById('setup-username').value.trim();
    if (!token || !username) { alert('Both fields are required.'); return; }
    saveConfig(token, username).then(function () { navigate('collection'); });
}

// ============ Collection View ============

function renderCollection() {
    Promise.all([dbGetAll('releases'), dbGetAll('folders'), dbGetAll('videos')]).then(function (results) {
        var allReleases = results[0];
        var folders = results[1].filter(function (f) { return f.id !== 0; });
        var allVideos = results[2];

        // Build accurate video counts from actual video records
        var videoCounts = {};
        allVideos.forEach(function (v) {
            videoCounts[v.release_id] = (videoCounts[v.release_id] || 0) + 1;
        });
        allReleases.forEach(function (r) {
            r.video_count = videoCounts[r.id] || 0;
        });

        // Filter
        var filtered = allReleases;
        var q = _filters.q.toLowerCase();
        if (q) {
            filtered = filtered.filter(function (r) {
                return r.artist.toLowerCase().indexOf(q) !== -1 ||
                       r.title.toLowerCase().indexOf(q) !== -1;
            });
        }
        if (_filters.genre) {
            filtered = filtered.filter(function (r) {
                return r.genres && r.genres.indexOf(_filters.genre) !== -1;
            });
        }
        if (_filters.folder) {
            var fid = parseInt(_filters.folder);
            filtered = filtered.filter(function (r) {
                return r.folder_ids && r.folder_ids.indexOf(fid) !== -1;
            });
        }
        if (_filters.country) {
            filtered = filtered.filter(function (r) {
                return r.country === _filters.country;
            });
        }

        // Sort
        var sortKey = _filters.sort || 'artist';
        filtered.sort(function (a, b) {
            switch (sortKey) {
                case 'title': return (a.title || '').localeCompare(b.title || '');
                case 'year': return (b.year || 0) - (a.year || 0);
                case 'date_added': return (b.date_added || '').localeCompare(a.date_added || '');
                default: return (a.artist || '').localeCompare(b.artist || '');
            }
        });

        // Paginate
        var perPage = 48;
        var page = _filters.page || 1;
        var totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
        if (page > totalPages) page = totalPages;
        var start = (page - 1) * perPage;
        var pageReleases = filtered.slice(start, start + perPage);

        // Get unique genres
        var genreSet = {};
        allReleases.forEach(function (r) {
            if (r.genres) r.genres.split(', ').forEach(function (g) { if (g) genreSet[g] = true; });
        });
        var genres = Object.keys(genreSet).sort();

        // Get unique countries
        var countrySet = {};
        allReleases.forEach(function (r) { if (r.country) countrySet[r.country] = true; });
        var countries = Object.keys(countrySet).sort();

        // Build HTML
        var html = '';

        // Header
        html += '<div class="collection-header"><div class="collection-stats">' +
                '<h1>Your Collection</h1>' +
                '<span class="stat-count">' + filtered.length + ' releases</span>' +
                '<div class="shuffle-controls">' +
                '<input type="number" id="shuffle-count" class="shuffle-count-input" value="50" min="1" max="9999" title="Number of tracks to shuffle">' +
                '<button class="btn btn-shuffle" onclick="shufflePlay()">🔀 Shuffle Play</button>' +
                '<button class="btn btn-shuffle-all" onclick="shufflePlayAll()">&#8734; Shuffle All</button>' +
                '</div>' +
                '</div>' +
                '<div class="search-bar">' +
                '<input type="text" class="search-input" id="search-input" placeholder="Search artist or title..." value="' + escHtml(_filters.q) + '" onkeydown="if(event.key===\'Enter\')doSearch()">' +
                '<button class="btn btn-search" onclick="doSearch()">Search</button>' +
                (_filters.q ? '<button class="btn btn-clear" onclick="clearSearch()">Clear</button>' : '') +
                '</div></div>';

        // Folder pills
        if (folders.length > 0) {
            html += '<div class="folder-pills"><span class="filter-label">Folder:</span>';
            html += '<span class="folder-pill' + (!_filters.folder ? ' active' : '') + '" onclick="setFilter(\'folder\',\'\')">All</span>';
            folders.forEach(function (f) {
                html += '<span class="folder-pill' + (_filters.folder == f.id ? ' active' : '') + '" onclick="setFilter(\'folder\',\'' + f.id + '\')">' + escHtml(f.name) + '</span>';
            });
            html += '</div>';
        }

        // Genre pills
        if (genres.length > 0) {
            html += '<div class="genre-pills"><span class="filter-label">Genre:</span>';
            html += '<span class="genre-pill' + (!_filters.genre ? ' active' : '') + '" onclick="setFilter(\'genre\',\'\')">All</span>';
            genres.forEach(function (g) {
                html += '<span class="genre-pill' + (_filters.genre === g ? ' active' : '') + '" onclick="setFilter(\'genre\',\'' + escJs(g) + '\')">' + escHtml(g) + '</span>';
            });
            html += '</div>';
        }

        // Country pills
        if (countries.length > 0) {
            html += '<div class="genre-pills"><span class="filter-label">Country:</span>';
            html += '<span class="genre-pill' + (!_filters.country ? ' active' : '') + '" onclick="setFilter(\'country\',\'\')">All</span>';
            countries.forEach(function (c) {
                html += '<span class="genre-pill' + (_filters.country === c ? ' active' : '') + '" onclick="setFilter(\'country\',\'' + escJs(c) + '\')">' + escHtml(c) + '</span>';
            });
            html += '</div>';
        }

        // Sort bar
        html += '<div class="sort-bar"><span class="sort-label">Sort by:</span>';
        ['artist', 'title', 'year', 'date_added'].forEach(function (s) {
            var label = s === 'date_added' ? 'Date Added' : s.charAt(0).toUpperCase() + s.slice(1);
            html += '<span class="sort-option' + (sortKey === s ? ' active' : '') + '" onclick="setSort(\'' + s + '\')">' + label + '</span>';
        });
        html += '</div>';

        // Grid
        if (pageReleases.length > 0) {
            html += '<div class="release-grid">';
            pageReleases.forEach(function (r) {
                html += '<div class="release-card" onclick="navigate(\'release\',{releaseId:' + r.id + '})">' +
                    '<div class="card-cover">';
                if (r.cover_url) {
                    html += '<img src="' + escHtml(r.cover_url) + '" alt="' + escHtml(r.artist) + '" loading="lazy">';
                } else {
                    html += '<div class="no-cover"><span class="vinyl-icon-large">&#9898;</span></div>';
                }
                var vc = r.video_count || 0;
                if (vc === 0) {
                    html += '<span class="badge badge-no-videos">No Videos</span>';
                } else {
                    html += '<span class="badge badge-videos">' + vc + ' video' + (vc !== 1 ? 's' : '') + '</span>';
                }
                if (r.quantity > 1) {
                    html += '<span class="badge badge-quantity">x' + r.quantity + '</span>';
                }
                html += '</div><div class="card-info">' +
                    '<div class="card-artist">' + escHtml(r.artist) + '</div>' +
                    '<div class="card-title">' + escHtml(r.title) + '</div>' +
                    '<div class="card-meta">';
                if (r.year) html += '<span>' + r.year + '</span>';
                if (r.format) html += '<span class="card-format">' + escHtml(r.format) + '</span>';
                html += '</div></div></div>';
            });
            html += '</div>';

            // Pagination
            if (totalPages > 1) {
                html += '<div class="pagination">';
                if (page > 1) html += '<span class="page-link" onclick="goPage(' + (page - 1) + ')">&laquo; Prev</span>';
                for (var p = 1; p <= totalPages; p++) {
                    if (p === page) {
                        html += '<span class="page-link active">' + p + '</span>';
                    } else if (p <= 3 || p > totalPages - 3 || (p >= page - 2 && p <= page + 2)) {
                        html += '<span class="page-link" onclick="goPage(' + p + ')">' + p + '</span>';
                    } else if (p === 4 || p === totalPages - 3) {
                        html += '<span class="page-dots">...</span>';
                    }
                }
                if (page < totalPages) html += '<span class="page-link" onclick="goPage(' + (page + 1) + ')">Next &raquo;</span>';
                html += '</div>';
            }
        } else {
            if (_filters.q || _filters.genre || _filters.folder || _filters.country) {
                html += '<div class="empty-state"><p class="empty-title">No releases found</p>' +
                        '<p class="empty-subtitle">Try a different search or filter</p>' +
                        '<button class="btn btn-primary" onclick="clearAllFilters()">Show All</button></div>';
            } else {
                html += '<div class="empty-state"><div class="vinyl-icon-huge">&#9898;</div>' +
                        '<p class="empty-title">Your collection is empty</p>' +
                        '<p class="empty-subtitle">Sync your Discogs collection to get started</p>' +
                        '<button class="btn btn-primary btn-large" onclick="startSync()"><span class="sync-icon">&#8635;</span> Sync Collection</button></div>';
            }
        }

        document.getElementById('app').innerHTML = html;
    });
}

// ============ Want List Sync ============

var _wantSyncRunning = false;

function startWantListSync() {
    if (_wantSyncRunning) return;
    getConfig().then(function (config) {
        if (!config.token || !config.username) { navigate('setup'); return; }
        _wantSyncRunning = true;
        var btn = document.getElementById('wl-sync-btn');
        if (btn) btn.disabled = true;
        showSyncBanner('Syncing want list...');
        syncWantList(config).then(function () {
            navigate('wantlist');
            showSyncBanner('Want list ready — fetching videos in background...');
            syncWantListVideosInBackground(config).catch(function (err) {
                showSyncBanner('Want list video sync failed: ' + err.message);
                console.error(err);
                _wantSyncRunning = false;
                var btn2 = document.getElementById('wl-sync-btn');
                if (btn2) btn2.disabled = false;
            });
        }).catch(function (err) {
            showSyncBanner('Want list sync failed: ' + err.message);
            console.error(err);
            _wantSyncRunning = false;
            var btn2 = document.getElementById('wl-sync-btn');
            if (btn2) btn2.disabled = false;
        });
    });
}

function startAvailabilityCheck() {
    if (_marketplaceSyncRunning) return;
    getConfig().then(function (config) {
        if (!config.token || !config.username) { navigate('setup'); return; }
        var btn = document.getElementById('wl-avail-btn');
        if (btn) btn.disabled = true;
        syncMarketplaceStats(config, false).then(function () {
            if (btn) btn.disabled = false;
        });
    });
}

async function syncWantList(config) {
    var page = 1;
    var allWants = {};
    while (true) {
        var path = '/users/' + config.username + '/wants?per_page=100&page=' + page;
        var data = await discogsGet(path, config);
        var items = data.wants || [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var info = item.basic_information || {};
            var rid = info.id;
            if (!rid) continue;
            var existing = await dbGet('wants', rid);
            allWants[rid] = {
                id: rid,
                title: info.title || 'Unknown',
                artist: (info.artists || []).map(function (a) { return a.name; }).join(', ') || 'Unknown',
                year: info.year || null,
                genres: (info.genres || []).join(', ') || null,
                styles: (info.styles || []).join(', ') || null,
                formats: (info.formats || []).map(function (f) { return f.name; }).join(', ') || null,
                labels: (info.labels || []).map(function (l) { return l.name; }).join(', ') || null,
                thumb_url: info.thumb || null,
                cover_url: info.cover_image || null,
                notes: item.notes || '',
                rating: item.rating || 0,
                date_added: item.date_added || null,
                video_count: existing ? (existing.video_count || 0) : 0,
                synced_at: existing ? (existing.synced_at || null) : null,
                country: existing ? (existing.country || null) : null
            };
        }
        var pagination = data.pagination || {};
        var totalPages = pagination.pages || 1;
        showSyncBanner('Want list: page ' + page + '/' + totalPages);
        if (page >= totalPages) break;
        page++;
        await sleep(1000);
    }

    var ids = Object.keys(allWants);
    for (var ri = 0; ri < ids.length; ri++) {
        await dbPut('wants', allWants[ids[ri]]);
    }

    var existingWants = await dbGetAll('wants');
    for (var ei = 0; ei < existingWants.length; ei++) {
        if (!allWants[existingWants[ei].id]) {
            await dbDelete('wants', existingWants[ei].id);
        }
    }
}

async function syncWantListVideosInBackground(config) {
    var wants = await dbGetAll('wants');
    var unsynced = wants.filter(function (w) { return !w.synced_at; });
    var total = unsynced.length;
    if (total === 0) {
        hideSyncBanner();
        _wantSyncRunning = false;
        var btn = document.getElementById('wl-sync-btn');
        if (btn) btn.disabled = false;
        return;
    }

    var startTime = Date.now();
    for (var vi = 0; vi < unsynced.length; vi++) {
        var want = unsynced[vi];
        var done = vi + 1;
        var elapsed = (Date.now() - startTime) / 1000;
        var avg = done > 1 ? elapsed / (done - 1) : 1.2;
        var remaining = Math.max(0, Math.round(avg * (total - done)));
        showSyncBanner('Want list videos: ' + done + '/' + total +
            ' (ETA ' + formatEta(remaining) + ') — ' + want.artist + ' — ' + want.title);
        try {
            var data = await discogsGet('/releases/' + want.id, config);
            var videos = data.videos || [];
            var vidCount = 0;
            for (var v = 0; v < videos.length; v++) {
                var vid = videos[v];
                if (!vid.embed) continue;
                var uri = vid.uri || '';
                if (uri.indexOf('youtube.com') === -1 && uri.indexOf('youtu.be') === -1) continue;
                var ytId = extractYoutubeId(uri);
                if (!ytId) continue;
                await dbPut('videos', {
                    id: want.id + '_' + ytId,
                    release_id: want.id,
                    title: vid.title || 'Untitled',
                    uri: uri,
                    youtube_id: ytId,
                    duration: vid.duration || null,
                    position: v + 1
                });
                vidCount++;
            }
            want.video_count = vidCount;
            want.synced_at = new Date().toISOString();
            want.country = data.country || want.country || null;
            await dbPut('wants', want);
        } catch (err) {
            console.error('Error fetching want release ' + want.id + ':', err);
        }
        if (done % 5 === 0 && _currentView === 'wantlist') renderWantList();
        if (vi < unsynced.length - 1) await sleep(1100);
    }

    showSyncBanner('Want list sync complete!');
    if (_currentView === 'wantlist') renderWantList();
    setTimeout(function () { hideSyncBanner(); }, 2000);
    _wantSyncRunning = false;
    var btn = document.getElementById('wl-sync-btn');
    if (btn) btn.disabled = false;

    // Kick off marketplace availability check silently after full sync
    syncMarketplaceStats(config, true).catch(function (err) {
        console.error('Marketplace stats sync failed:', err);
    });
}

// ============ Want List View ============

function renderWantList() {
    Promise.all([
        dbGetAll('wants'),
        dbGetAll('releases'),
        dbGetAll('videos'),
        dbGetAll('marketplace_stats')
    ]).then(function (results) {
        var allWants = results[0];
        var allCollectionReleases = results[1];
        var allVideos = results[2];
        var allStats = results[3];

        var statsMap = {};
        allStats.forEach(function (s) { statsMap[s.id] = s; });

        // Build collection IDs set for cross-reference
        var collectionIds = {};
        allCollectionReleases.forEach(function (r) { collectionIds[r.id] = true; });

        // Accurate video counts from video records
        var videoCounts = {};
        allVideos.forEach(function (v) {
            videoCounts[v.release_id] = (videoCounts[v.release_id] || 0) + 1;
        });
        allWants.forEach(function (w) { w.video_count = videoCounts[w.id] || 0; });

        var wf = _filters.wantlist;

        // Filter
        var filtered = allWants;
        var q = (wf.q || '').toLowerCase();
        if (q) {
            filtered = filtered.filter(function (w) {
                return w.artist.toLowerCase().indexOf(q) !== -1 ||
                       w.title.toLowerCase().indexOf(q) !== -1;
            });
        }
        if (wf.genre) {
            filtered = filtered.filter(function (w) {
                return w.genres && w.genres.indexOf(wf.genre) !== -1;
            });
        }
        if (wf.format) {
            filtered = filtered.filter(function (w) {
                return w.formats && w.formats.indexOf(wf.format) !== -1;
            });
        }
        if (wf.decade) {
            var decadeStart = parseInt(wf.decade, 10);
            filtered = filtered.filter(function (w) {
                return w.year && w.year >= decadeStart && w.year < decadeStart + 10;
            });
        }
        if (wf.country) {
            filtered = filtered.filter(function (w) {
                return w.country === wf.country;
            });
        }

        // Sort
        var sortKey = wf.sort || 'artist';
        filtered.sort(function (a, b) {
            switch (sortKey) {
                case 'title':      return (a.title || '').localeCompare(b.title || '');
                case 'year':       return (b.year || 0) - (a.year || 0);
                case 'date_added': return (b.date_added || '').localeCompare(a.date_added || '');
                case 'rating':     return (b.rating || 0) - (a.rating || 0);
                default:           return (a.artist || '').localeCompare(b.artist || '');
            }
        });

        // Paginate
        var perPage = 48;
        var page = wf.page || 1;
        var totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
        if (page > totalPages) page = totalPages;
        var start = (page - 1) * perPage;
        var pageWants = filtered.slice(start, start + perPage);

        // Stats
        var decadeCounts = {};
        var genreCounts = {};
        var formatCounts = {};
        var notInCollection = 0;
        var genreSet = {};
        var formatSet = {};
        var countrySet = {};
        allWants.forEach(function (w) {
            if (w.year) {
                var dec = Math.floor(w.year / 10) * 10;
                decadeCounts[dec] = (decadeCounts[dec] || 0) + 1;
            }
            if (w.genres) w.genres.split(', ').forEach(function (g) {
                if (g) { genreCounts[g] = (genreCounts[g] || 0) + 1; genreSet[g] = true; }
            });
            if (w.formats) w.formats.split(', ').forEach(function (f) {
                if (f) { formatCounts[f] = (formatCounts[f] || 0) + 1; formatSet[f] = true; }
            });
            if (w.country) countrySet[w.country] = true;
            if (!collectionIds[w.id]) notInCollection++;
        });

        var topGenres = Object.keys(genreCounts).sort(function (a, b) {
            return genreCounts[b] - genreCounts[a];
        }).slice(0, 5);

        var genres = Object.keys(genreSet).sort();
        var formats = Object.keys(formatSet).sort();
        var countries = Object.keys(countrySet).sort();
        var decadesSorted = Object.keys(decadeCounts).map(Number).sort(function (a, b) { return a - b; });

        // ---- Build HTML ----
        var html = '';

        // Header
        html += '<div class="collection-header">';
        html += '<div class="collection-stats">';
        html += '<h1>Want List</h1>';
        html += '<span class="stat-count">' + allWants.length + ' wants';
        if (filtered.length !== allWants.length) html += ' &nbsp;(' + filtered.length + ' shown)';
        html += '</span>';
        html += '<div class="shuffle-controls">';
        html += '<input type="number" id="wl-shuffle-count" class="shuffle-count-input" value="50" min="1" max="9999" title="Number of tracks to shuffle">';
        html += '<button class="btn btn-shuffle" onclick="wlShufflePlay()">🔀 Shuffle Wants</button>';
        html += '<button class="btn btn-shuffle-all" onclick="wlShufflePlayAll()">∞ Shuffle All</button>';
        html += '</div>';
        html += '</div>';
        html += '<div class="wl-header-actions">';
        html += '<button class="btn btn-primary" id="wl-sync-btn" onclick="startWantListSync()"' + (_wantSyncRunning ? ' disabled' : '') + '>';
        html += '<span class="sync-icon">↻</span> Sync Want List</button>';
        html += '<button class="btn" id="wl-avail-btn" onclick="startAvailabilityCheck()"' + (_marketplaceSyncRunning ? ' disabled' : '') + ' title="Check how many copies are listed on the marketplace">&#128722; Check Availability</button>';
        html += '<button class="btn" onclick="exportWantListCSV()" title="Export as CSV">↓ CSV</button>';
        html += '</div>';
        html += '</div>';

        // Search bar
        html += '<div class="search-bar" style="margin-bottom:16px;">';
        html += '<input type="text" class="search-input" id="wl-search-input" placeholder="Search artist or title..." value="' + escHtml(wf.q) + '" onkeydown="if(event.key===\'Enter\')wlDoSearch()">';
        html += '<button class="btn btn-search" onclick="wlDoSearch()">Search</button>';
        if (wf.q) html += '<button class="btn btn-clear" onclick="wlClearSearch()">Clear</button>';
        html += '</div>';

        // Stats bar
        html += '<div class="wl-stats-bar">';

        // Decade filter pills inside stats bar
        if (decadesSorted.length > 0) {
            html += '<div class="wl-stat-group"><span class="filter-label">Decade:</span>';
            html += '<span class="decade-pill' + (!wf.decade ? ' active' : '') + '" onclick="wlSetFilter(\'decade\',\'\')">All</span>';
            decadesSorted.forEach(function (d) {
                html += '<span class="decade-pill' + (String(wf.decade) === String(d) ? ' active' : '') + '" onclick="wlSetFilter(\'decade\',' + d + ')">' +
                    d + 's <span class="pill-count">' + decadeCounts[d] + '</span></span>';
            });
            html += '</div>';
        }

        // Top genres as clickable chips
        if (topGenres.length > 0) {
            html += '<div class="wl-stat-group"><span class="filter-label">Top genres:</span>';
            topGenres.forEach(function (g) {
                html += '<span class="wl-stat-chip' + (wf.genre === g ? ' active' : '') + '" onclick="wlSetFilter(\'genre\',\'' + escJs(g) + '\')">' +
                    escHtml(g) + ' <span class="pill-count">' + genreCounts[g] + '</span></span>';
            });
            html += '</div>';
        }

        // Collection cross-ref + dig deeper
        html += '<div class="wl-stat-group">';
        html += '<span class="wl-stat-chip wl-not-owned">' + notInCollection + ' not in collection</span>';
        if (allWants.length > 0) {
            html += '<span class="wl-stat-chip wl-dd-btn" onclick="wlDigDeeper()">🔍 Dig Deeper</span>';
        }
        html += '</div>';

        html += '</div>'; // .wl-stats-bar

        // Dig deeper panel (populated by wlDigDeeper())
        html += '<div id="wl-dig-deeper-panel" style="display:none;"></div>';

        // Genre filter pills
        if (genres.length > 0) {
            html += '<div class="genre-pills"><span class="filter-label">Genre:</span>';
            html += '<span class="genre-pill' + (!wf.genre ? ' active' : '') + '" onclick="wlSetFilter(\'genre\',\'\')">All</span>';
            genres.forEach(function (g) {
                html += '<span class="genre-pill' + (wf.genre === g ? ' active' : '') + '" onclick="wlSetFilter(\'genre\',\'' + escJs(g) + '\')">' + escHtml(g) + '</span>';
            });
            html += '</div>';
        }

        // Format filter pills
        if (formats.length > 0) {
            html += '<div class="genre-pills"><span class="filter-label">Format:</span>';
            html += '<span class="genre-pill' + (!wf.format ? ' active' : '') + '" onclick="wlSetFilter(\'format\',\'\')">All</span>';
            formats.forEach(function (f) {
                html += '<span class="genre-pill' + (wf.format === f ? ' active' : '') + '" onclick="wlSetFilter(\'format\',\'' + escJs(f) + '\')">' + escHtml(f) + '</span>';
            });
            html += '</div>';
        }

        // Country filter pills
        if (countries.length > 0) {
            html += '<div class="genre-pills"><span class="filter-label">Country:</span>';
            html += '<span class="genre-pill' + (!wf.country ? ' active' : '') + '" onclick="wlSetFilter(\'country\',\'\')">All</span>';
            countries.forEach(function (c) {
                html += '<span class="genre-pill' + (wf.country === c ? ' active' : '') + '" onclick="wlSetFilter(\'country\',\'' + escJs(c) + '\')">' + escHtml(c) + '</span>';
            });
            html += '</div>';
        }

        // Sort bar
        html += '<div class="sort-bar"><span class="sort-label">Sort by:</span>';
        [['artist', 'Artist'], ['title', 'Title'], ['year', 'Year'], ['date_added', 'Date Added'], ['rating', 'Rating']].forEach(function (pair) {
            html += '<span class="sort-option' + (sortKey === pair[0] ? ' active' : '') + '" onclick="wlSetSort(\'' + pair[0] + '\')">' + pair[1] + '</span>';
        });
        html += '</div>';

        // Grid / empty states
        if (allWants.length === 0) {
            html += '<div class="empty-state"><div class="vinyl-icon-huge">&#9898;</div>' +
                '<p class="empty-title">Your want list is empty</p>' +
                '<p class="empty-subtitle">Sync your Discogs want list to see it here</p>' +
                '<button class="btn btn-primary btn-large" onclick="startWantListSync()"><span class="sync-icon">&#8635;</span> Sync Want List</button></div>';
        } else if (filtered.length === 0) {
            html += '<div class="empty-state"><p class="empty-title">No wants match.</p>' +
                '<button class="btn btn-primary" onclick="wlClearFilters()">Clear filters</button></div>';
        } else {
            html += '<div class="release-grid wl-grid">';
            pageWants.forEach(function (w) {
                var vc = w.video_count || 0;
                var inCollection = !!collectionIds[w.id];
                html += '<div class="release-card wl-card">';
                html += '<div class="card-cover">';
                if (w.cover_url) {
                    html += '<img src="' + escHtml(w.cover_url) + '" alt="' + escHtml(w.artist) + '" loading="lazy">';
                } else {
                    html += '<div class="no-cover"><span class="vinyl-icon-large">&#9898;</span></div>';
                }
                if (vc > 0) {
                    html += '<span class="badge badge-videos">' + vc + ' video' + (vc !== 1 ? 's' : '') + '</span>';
                }
                if (inCollection) {
                    html += '<span class="badge badge-owned">Owned</span>';
                }
                if (w.rating) {
                    html += '<span class="badge badge-wl-rating">' + ratingStars(w.rating) + '</span>';
                }
                var wStats = statsMap[w.id];
                if (wStats && wStats.num_for_sale > 0) {
                    var saleTxt = wStats.num_for_sale + ' for sale';
                    if (wStats.lowest_price) saleTxt += ' · ' + (wStats.currency || '') + ' ' + Number(wStats.lowest_price).toFixed(2);
                    html += '<span class="badge badge-for-sale" title="' + saleTxt + '">' + wStats.num_for_sale + ' for sale</span>';
                } else if (wStats && wStats.num_for_sale === 0) {
                    html += '<span class="badge badge-not-for-sale">None listed</span>';
                }
                html += '</div>';

                html += '<div class="card-info">';
                html += '<div class="card-artist">' + escHtml(w.artist) + '</div>';
                html += '<div class="card-title">' + escHtml(w.title) + '</div>';
                html += '<div class="card-meta">';
                if (w.year) html += '<span>' + w.year + '</span>';
                if (w.formats) html += '<span class="card-format">' + escHtml(w.formats) + '</span>';
                html += '</div>';
                if (w.notes) {
                    html += '<div class="wl-notes" title="' + escHtml(w.notes) + '">' +
                        escHtml(w.notes.length > 70 ? w.notes.slice(0, 70) + '…' : w.notes) + '</div>';
                }
                html += '<div class="wl-card-actions">';
                if (vc > 0) {
                    html += '<button class="btn btn-sm btn-primary" onclick="wlPlayRelease(' + w.id + ')" title="Play videos">&#9654;</button>';
                }
                html += '<a class="btn btn-sm" href="https://www.discogs.com/release/' + w.id + '" target="_blank" rel="noopener" title="View on Discogs">&#8599;</a>';
                html += '<a class="btn btn-sm btn-primary" href="https://www.discogs.com/sell/release/' + w.id + '" target="_blank" rel="noopener" title="Buy on Discogs marketplace">&#128722;</a>';
                html += '<button class="btn btn-sm" onclick="wlOpenPricePanel(' + w.id + ', this)" title="Price suggestions">$</button>';
                html += '<button class="btn btn-sm btn-danger" onclick="wlRemove(' + w.id + ',\'' + escJs(w.artist) + '\',\'' + escJs(w.title) + '\')" title="Remove from want list">&times;</button>';
                html += '</div>';
                html += '</div>';

                html += '<div class="wl-price-panel" id="wl-price-' + w.id + '" style="display:none;"></div>';
                html += '</div>';
            });
            html += '</div>';

            // Pagination
            if (totalPages > 1) {
                html += '<div class="pagination">';
                if (page > 1) html += '<span class="page-link" onclick="wlGoPage(' + (page - 1) + ')">&laquo; Prev</span>';
                for (var p = 1; p <= totalPages; p++) {
                    if (p === page) {
                        html += '<span class="page-link active">' + p + '</span>';
                    } else if (p <= 3 || p > totalPages - 3 || (p >= page - 2 && p <= page + 2)) {
                        html += '<span class="page-link" onclick="wlGoPage(' + p + ')">' + p + '</span>';
                    } else if (p === 4 || p === totalPages - 3) {
                        html += '<span class="page-dots">...</span>';
                    }
                }
                if (page < totalPages) html += '<span class="page-link" onclick="wlGoPage(' + (page + 1) + ')">Next &raquo;</span>';
                html += '</div>';
            }
        }

        document.getElementById('app').innerHTML = html;
    });
}

// ============ Want List Filter Helpers ============

function wlDoSearch() {
    var el = document.getElementById('wl-search-input');
    _filters.wantlist.q = el ? el.value.trim() : '';
    _filters.wantlist.page = 1;
    renderWantList();
}
function wlClearSearch() { _filters.wantlist.q = ''; _filters.wantlist.page = 1; renderWantList(); }
function wlSetFilter(k, v) { _filters.wantlist[k] = v; _filters.wantlist.page = 1; renderWantList(); }
function wlSetSort(s) { _filters.wantlist.sort = s; renderWantList(); }
function wlGoPage(p) { _filters.wantlist.page = p; renderWantList(); window.scrollTo(0, 0); }
function wlClearFilters() {
    _filters.wantlist = { q: '', genre: '', format: '', decade: '', country: '', sort: 'artist', page: 1 };
    renderWantList();
}

// ============ Want List Player ============

function wlPlayRelease(releaseId) {
    if (!playerReady) return;
    dbGetByIndex('videos', 'release_id', releaseId).then(function (videos) {
        if (!videos || videos.length === 0) {
            alert('No videos found for this release. Try syncing the want list first.');
            return;
        }
        return dbGet('wants', releaseId).then(function (w) {
            videos.sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
            currentQueue = videos.map(function (v) {
                return {
                    youtubeId: v.youtube_id,
                    title: v.title,
                    releaseId: releaseId,
                    artist: w ? w.artist : '',
                    cover: w ? (w.thumb_url || '') : ''
                };
            });
            currentIndex = 0;
            loadFromQueue(0);
        });
    });
}

function wlShufflePlay(limitOverride) {
    if (!playerReady) return;
    dbGetAll('wants').then(function (allWants) {
        var wf = _filters.wantlist;
        var filtered = allWants;
        var q = (wf.q || '').toLowerCase();
        if (q) filtered = filtered.filter(function (w) {
            return w.artist.toLowerCase().indexOf(q) !== -1 || w.title.toLowerCase().indexOf(q) !== -1;
        });
        if (wf.genre) filtered = filtered.filter(function (w) {
            return w.genres && w.genres.indexOf(wf.genre) !== -1;
        });
        if (wf.format) filtered = filtered.filter(function (w) {
            return w.formats && w.formats.indexOf(wf.format) !== -1;
        });
        if (wf.decade) {
            var ds = parseInt(wf.decade, 10);
            filtered = filtered.filter(function (w) { return w.year && w.year >= ds && w.year < ds + 10; });
        }
        if (wf.country) filtered = filtered.filter(function (w) { return w.country === wf.country; });

        var ids = filtered.map(function (w) { return w.id; });
        if (ids.length === 0) { alert('No wants match the current filters.'); return; }

        dbGetAll('videos').then(function (allVideos) {
            var matchingVideos = allVideos.filter(function (v) {
                return v.youtube_id && ids.indexOf(v.release_id) !== -1;
            });
            if (matchingVideos.length === 0) {
                alert('No videos found for your want list. Sync the want list first to fetch them.');
                return;
            }

            for (var i = matchingVideos.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = matchingVideos[i];
                matchingVideos[i] = matchingVideos[j];
                matchingVideos[j] = tmp;
            }

            var limit;
            if (typeof limitOverride === 'number') {
                limit = limitOverride;
            } else {
                var inputEl = document.getElementById('wl-shuffle-count');
                var parsed = inputEl ? parseInt(inputEl.value, 10) : NaN;
                limit = (!isNaN(parsed) && parsed >= 1) ? parsed : 50;
            }
            var selected = (limit === Infinity || limit >= matchingVideos.length)
                ? matchingVideos
                : matchingVideos.slice(0, limit);

            var wantMap = {};
            filtered.forEach(function (w) { wantMap[w.id] = w; });

            currentQueue = selected.map(function (v) {
                var w = wantMap[v.release_id] || {};
                return {
                    youtubeId: v.youtube_id,
                    title: v.title,
                    releaseId: v.release_id,
                    artist: w.artist || '',
                    cover: w.thumb_url || ''
                };
            });
            currentIndex = 0;
            loadFromQueue(0);
            _renderQueuePanel();
        });
    });
}

function wlShufflePlayAll() { wlShufflePlay(Infinity); }

// ============ Want List Actions ============

function wlRemove(releaseId, artist, title) {
    if (!confirm('Remove “' + artist + ' — ' + title + '” from your Discogs want list?')) return;
    getConfig().then(function (config) {
        fetch('https://api.discogs.com/users/' + config.username + '/wants/' + releaseId, {
            method: 'DELETE',
            headers: {
                'Authorization': 'Discogs token=' + config.token,
                'User-Agent': 'VinylCollectionPlayer/2.0'
            }
        }).then(function (r) {
            if (r.ok || r.status === 204) {
                return dbDelete('wants', releaseId).then(function () {
                    showSyncBanner('Removed from want list');
                    setTimeout(hideSyncBanner, 2000);
                    renderWantList();
                });
            } else {
                alert('Failed to remove from Discogs (HTTP ' + r.status + ')');
            }
        }).catch(function (err) {
            alert('Error: ' + err.message);
        });
    });
}

function wlOpenPricePanel(releaseId, btn) {
    var panel = document.getElementById('wl-price-' + releaseId);
    if (!panel) return;
    if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
    panel.innerHTML = '<div class="wl-price-loading">Loading prices…</div>';
    panel.style.display = 'block';
    getConfig().then(function (config) {
        discogsGet('/marketplace/price_suggestions/' + releaseId, config).then(function (data) {
            var conditions = [
                'Mint (M)', 'Near Mint (NM or M-)', 'Very Good Plus (VG+)',
                'Very Good (VG)', 'Good Plus (G+)', 'Good (G)', 'Fair (F)', 'Poor (P)'
            ];
            var html = '<div class="wl-price-table">';
            html += '<div class="wl-price-header">Price Suggestions</div>';
            var hasData = false;
            conditions.forEach(function (cond) {
                var entry = data[cond];
                if (!entry || !entry.value) return;
                hasData = true;
                html += '<div class="wl-price-row">';
                html += '<span class="wl-price-cond">' + escHtml(cond.split('(')[0].trim()) + '</span>';
                html += '<span class="wl-price-val">' + escHtml(entry.currency || '') + ' ' + Number(entry.value).toFixed(2) + '</span>';
                html += '</div>';
            });
            if (!hasData) html += '<div class="wl-price-empty">No price data available.</div>';
            html += '</div>';
            panel.innerHTML = html;
        }).catch(function () {
            panel.innerHTML = '<div class="wl-price-empty">Could not load prices.</div>';
        });
    });
}

// ============ Marketplace Stats & Notifications ============

var _marketplacePollInterval = null;
var _marketplaceSyncRunning = false;

async function syncMarketplaceStats(config, silent) {
    if (_marketplaceSyncRunning) return;
    _marketplaceSyncRunning = true;
    var wants = await dbGetAll('wants');
    if (wants.length === 0) { _marketplaceSyncRunning = false; return; }

    if (!silent) showSyncBanner('Checking marketplace availability (0/' + wants.length + ')...');

    for (var i = 0; i < wants.length; i++) {
        var w = wants[i];
        if (!silent) showSyncBanner('Checking availability: ' + (i + 1) + '/' + wants.length + ' — ' + w.artist);
        try {
            var data = await discogsGet('/marketplace/stats/' + w.id, config);
            var numForSale = (data && data.num_for_sale) || 0;
            var lowestPrice = (data && data.lowest_price) ? data.lowest_price.value : null;
            var currency = (data && data.lowest_price) ? data.lowest_price.currency : null;

            var existing = await dbGet('marketplace_stats', w.id);
            var prevNum = existing ? (existing.num_for_sale || 0) : null;

            // Create notification when listings appear for the first time (was 0 or unknown)
            if (numForSale > 0 && (prevNum === null || prevNum === 0)) {
                await dbPut('notifications', {
                    release_id: w.id,
                    artist: w.artist,
                    title: w.title,
                    num_for_sale: numForSale,
                    lowest_price: lowestPrice,
                    currency: currency,
                    seen: false,
                    created_at: new Date().toISOString()
                });
                updateNotifBadge();
            } else if (numForSale !== (existing ? existing.num_for_sale : null)) {
                // Silently update stored stats when count changes (up or down)
            }

            await dbPut('marketplace_stats', {
                id: w.id,
                num_for_sale: numForSale,
                lowest_price: lowestPrice,
                currency: currency,
                checked_at: new Date().toISOString()
            });
        } catch (err) {
            console.error('Marketplace stats error for ' + w.id + ':', err);
        }
        if (i < wants.length - 1) await sleep(1100);
    }

    _marketplaceSyncRunning = false;
    if (_currentView === 'wantlist') renderWantList();
    if (!silent) {
        showSyncBanner('Availability check complete!');
        setTimeout(hideSyncBanner, 2000);
    }
}

function startMarketplacePoll() {
    if (_marketplacePollInterval) return;
    _marketplacePollInterval = setInterval(function () {
        getConfig().then(function (config) {
            if (config.token && config.username && !_marketplaceSyncRunning && !_wantSyncRunning) {
                syncMarketplaceStats(config, true);
            }
        });
    }, 30 * 60 * 1000);
}

function updateNotifBadge() {
    return dbGetAll('notifications').then(function (all) {
        var unseen = all.filter(function (n) { return !n.seen; }).length;
        var badge = document.getElementById('notif-badge');
        if (!badge) return;
        badge.textContent = unseen;
        badge.style.display = unseen > 0 ? 'inline-flex' : 'none';
    });
}

function toggleNotifPanel() {
    var panel = document.getElementById('notif-panel');
    if (!panel) return;
    if (panel.classList.contains('open')) {
        closeNotifPanel();
    } else {
        openNotifPanel();
    }
}

function openNotifPanel() {
    dbGetAll('notifications').then(function (notifications) {
        var markPromises = notifications.filter(function (n) { return !n.seen; }).map(function (n) {
            n.seen = true;
            return dbPut('notifications', n);
        });
        Promise.all(markPromises).then(function () { updateNotifBadge(); });

        notifications.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });

        var html = '<div class="notif-header">';
        html += '<span class="notif-title">Marketplace Alerts</span>';
        html += '<div class="notif-header-actions">';
        if (notifications.length > 0) {
            html += '<button class="btn btn-sm btn-danger" onclick="clearAllNotifications()">Clear all</button>';
        }
        html += '<button class="btn btn-sm" onclick="closeNotifPanel()">&times;</button>';
        html += '</div></div>';

        html += '<div class="notif-list">';
        if (notifications.length === 0) {
            html += '<div class="notif-empty">No alerts yet.<br>You\'ll be notified when records on your want list go on sale.</div>';
        } else {
            notifications.forEach(function (n) {
                html += '<div class="notif-item">';
                html += '<div class="notif-item-info">';
                html += '<div class="notif-item-artist">' + escHtml(n.artist) + '</div>';
                html += '<div class="notif-item-title">' + escHtml(n.title) + '</div>';
                html += '<div class="notif-item-detail">';
                html += '<span class="notif-count">' + n.num_for_sale + ' for sale';
                if (n.lowest_price) html += ' · ' + (n.currency || '') + ' ' + Number(n.lowest_price).toFixed(2);
                html += '</span>';
                html += '<span class="notif-time">' + formatTimeAgo(n.created_at) + '</span>';
                html += '</div></div>';
                html += '<a class="btn btn-sm btn-primary" href="https://www.discogs.com/sell/release/' + n.release_id + '" target="_blank" rel="noopener" onclick="closeNotifPanel()">Buy &#128722;</a>';
                html += '</div>';
            });
        }
        html += '</div>';

        var panel = document.getElementById('notif-panel');
        panel.innerHTML = html;
        panel.classList.add('open');
    });
}

function closeNotifPanel() {
    var panel = document.getElementById('notif-panel');
    if (panel) panel.classList.remove('open');
}

function clearAllNotifications() {
    dbClear('notifications').then(function () {
        updateNotifBadge();
        openNotifPanel();
    });
}

function formatTimeAgo(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
}

function exportWantListCSV() {
    dbGetAll('wants').then(function (wants) {
        var lines = ['Artist,Title,Year,Formats,Genres,Styles,Labels,Notes,Rating,Date Added'];
        wants.forEach(function (w) {
            lines.push([
                _csvCell(w.artist), _csvCell(w.title), _csvCell(w.year || ''),
                _csvCell(w.formats || ''), _csvCell(w.genres || ''), _csvCell(w.styles || ''),
                _csvCell(w.labels || ''), _csvCell(w.notes || ''),
                _csvCell(w.rating || ''), _csvCell(w.date_added || '')
            ].join(','));
        });
        downloadBlob('want-list.csv', 'text/csv', lines.join('\n') + '\n');
    });
}

function wlDigDeeper() {
    var panel = document.getElementById('wl-dig-deeper-panel');
    if (!panel) return;
    if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
    panel.innerHTML = '<div class="wl-price-loading">Analysing…</div>';
    panel.style.display = 'block';

    Promise.all([dbGetAll('wants'), dbGetAll('releases')]).then(function (results) {
        var wants = results[0];
        var collection = results[1];

        var collGenres = {};
        var collStyles = {};
        var collArtists = {};
        collection.forEach(function (r) {
            if (r.genres) r.genres.split(', ').forEach(function (g) { if (g) collGenres[g] = true; });
            if (r.styles) r.styles.split(', ').forEach(function (s) { if (s) collStyles[s] = true; });
            if (r.artist) r.artist.split(', ').forEach(function (a) { a = a.trim(); if (a) collArtists[a] = true; });
        });

        var newGenreCounts = {};
        var newStyleCounts = {};
        var newArtistCounts = {};
        wants.forEach(function (w) {
            if (w.genres) w.genres.split(', ').forEach(function (g) {
                if (g && !collGenres[g]) newGenreCounts[g] = (newGenreCounts[g] || 0) + 1;
            });
            if (w.styles) w.styles.split(', ').forEach(function (s) {
                if (s && !collStyles[s]) newStyleCounts[s] = (newStyleCounts[s] || 0) + 1;
            });
            if (w.artist) w.artist.split(', ').forEach(function (a) {
                a = a.trim();
                if (a && !collArtists[a]) newArtistCounts[a] = (newArtistCounts[a] || 0) + 1;
            });
        });

        var topNewGenres  = Object.keys(newGenreCounts).sort(function (a, b) { return newGenreCounts[b]  - newGenreCounts[a];  }).slice(0, 10);
        var topNewStyles  = Object.keys(newStyleCounts).sort(function (a, b) { return newStyleCounts[b]  - newStyleCounts[a];  }).slice(0, 10);
        var topNewArtists = Object.keys(newArtistCounts).sort(function (a, b) { return newArtistCounts[b] - newArtistCounts[a]; }).slice(0, 10);

        var html = '<div class="wl-dig-deeper">';
        html += '<div class="wl-dd-header"><h3>🔍 Dig Deeper — Gaps in Your Collection</h3>';
        html += '<button class="btn btn-clear" onclick="document.getElementById(\'wl-dig-deeper-panel\').style.display=\'none\'">Close</button></div>';
        html += '<p class="wl-dd-subtitle">Genres, styles, and artists from your want list not yet represented in your collection:</p>';

        if (topNewGenres.length > 0) {
            html += '<div class="wl-dd-section"><h4>New Genres</h4><div class="genre-pills">';
            topNewGenres.forEach(function (g) {
                html += '<span class="genre-pill" onclick="wlSetFilter(\'genre\',\'' + escJs(g) + '\')">' +
                    escHtml(g) + ' <span class="pill-count">' + newGenreCounts[g] + '</span></span>';
            });
            html += '</div></div>';
        }

        if (topNewStyles.length > 0) {
            html += '<div class="wl-dd-section"><h4>New Styles</h4><div class="genre-pills">';
            topNewStyles.forEach(function (s) {
                html += '<span class="genre-pill">' + escHtml(s) + ' <span class="pill-count">' + newStyleCounts[s] + '</span></span>';
            });
            html += '</div></div>';
        }

        if (topNewArtists.length > 0) {
            html += '<div class="wl-dd-section"><h4>New Artists</h4><div class="genre-pills">';
            topNewArtists.forEach(function (a) {
                html += '<span class="genre-pill">' + escHtml(a) + '</span>';
            });
            html += '</div></div>';
        }

        if (!topNewGenres.length && !topNewStyles.length && !topNewArtists.length) {
            html += '<p class="empty-subtitle" style="padding:16px 0;">All genres and artists in your want list are already in your collection!</p>';
        }

        html += '</div>';
        panel.innerHTML = html;
    });
}

// ============ Tracks View ============

function renderTracks() {
    Promise.all([
        dbGetAll('videos'),
        dbGetAll('releases'),
        dbGetAll('track_meta')
    ]).then(function (results) {
        var allVideos = results[0];
        var allReleases = results[1];
        var allMeta = results[2];

        var tf = _filters.tracks;
        var relById = {};
        allReleases.forEach(function (r) { relById[r.id] = r; });
        var metaById = {};
        allMeta.forEach(function (m) { metaById[m.id] = m; });

        // Flatten to rows
        var rows = allVideos.map(function (v) {
            var r = relById[v.release_id] || {};
            var m = metaById[v.release_id + '_' + v.youtube_id] || {};
            return {
                metaId: v.release_id + '_' + v.youtube_id,
                youtubeId: v.youtube_id,
                videoTitle: v.title || '',
                duration: v.duration || null,
                artist: r.artist || 'Unknown',
                releaseTitle: r.title || '',
                releaseId: v.release_id,
                year: r.year || null,
                genres: r.genres || '',
                cover: r.thumb_url || '',
                bpm: m.bpm != null ? m.bpm : null,
                key: m.key || null,
                rating: m.rating || null,
                shelf: m.shelf || '',
                tags: m.tags || []
            };
        });

        // Filter
        var q = (tf.q || '').toLowerCase();
        if (q) {
            rows = rows.filter(function (row) {
                return row.videoTitle.toLowerCase().indexOf(q) !== -1 ||
                       row.artist.toLowerCase().indexOf(q) !== -1 ||
                       row.releaseTitle.toLowerCase().indexOf(q) !== -1;
            });
        }
        if (tf.bpmMin !== '' && tf.bpmMin != null) {
            var minB = parseFloat(tf.bpmMin);
            if (isFinite(minB)) rows = rows.filter(function (row) { return row.bpm != null && row.bpm >= minB; });
        }
        if (tf.bpmMax !== '' && tf.bpmMax != null) {
            var maxB = parseFloat(tf.bpmMax);
            if (isFinite(maxB)) rows = rows.filter(function (row) { return row.bpm != null && row.bpm <= maxB; });
        }
        if (tf.key) {
            rows = rows.filter(function (row) { return row.key === tf.key; });
        }
        if (tf.minRating) {
            var mr = parseInt(tf.minRating, 10);
            rows = rows.filter(function (row) { return (row.rating || 0) >= mr; });
        }
        if (tf.tag) {
            rows = rows.filter(function (row) { return row.tags.indexOf(tf.tag) !== -1; });
        }

        // Sort
        var sortKey = tf.sort || 'artist';
        rows.sort(function (a, b) {
            switch (sortKey) {
                case 'title': return (a.videoTitle || '').localeCompare(b.videoTitle || '');
                case 'year': return (b.year || 0) - (a.year || 0);
                case 'bpm': return (b.bpm || 0) - (a.bpm || 0);
                case 'rating': return (b.rating || 0) - (a.rating || 0);
                case 'release': return (a.releaseTitle || '').localeCompare(b.releaseTitle || '');
                default: return (a.artist || '').localeCompare(b.artist || '');
            }
        });

        // Paginate
        var perPage = 48;
        var page = tf.page || 1;
        var totalPages = Math.max(1, Math.ceil(rows.length / perPage));
        if (page > totalPages) page = totalPages;
        var start = (page - 1) * perPage;
        var pageRows = rows.slice(start, start + perPage);

        // Collect unique tags
        var tagSet = {};
        allMeta.forEach(function (m) { (m.tags || []).forEach(function (t) { if (t) tagSet[t] = true; }); });
        var tagList = Object.keys(tagSet).sort();

        // Build HTML
        var html = '';
        html += '<div class="collection-header"><div class="collection-stats">' +
            '<h1>All Tracks</h1>' +
            '<span class="stat-count">' + rows.length + ' tracks</span>' +
            '</div>' +
            '<div class="search-bar">' +
            '<input type="text" class="search-input" id="tracks-search-input" placeholder="Search title, artist, release..." value="' + escHtml(tf.q) + '" onkeydown="if(event.key===\'Enter\')tDoSearch()">' +
            '<button class="btn btn-search" onclick="tDoSearch()">Search</button>' +
            (tf.q ? '<button class="btn btn-clear" onclick="tClearSearch()">Clear</button>' : '') +
            '</div></div>';

        // Filters
        html += '<div class="track-filters">';
        html += '<div class="track-filter-group"><label>BPM</label>' +
            '<input type="number" class="bpm-input" placeholder="min" value="' + escHtml(tf.bpmMin) + '" onchange="tSetBpm(\'bpmMin\', this.value)">' +
            '<span class="bpm-dash">&ndash;</span>' +
            '<input type="number" class="bpm-input" placeholder="max" value="' + escHtml(tf.bpmMax) + '" onchange="tSetBpm(\'bpmMax\', this.value)">' +
            '</div>';

        html += '<div class="track-filter-group"><label>Key</label><select onchange="tSetFilter(\'key\', this.value)">';
        html += '<option value=""' + (!tf.key ? ' selected' : '') + '>Any</option>';
        for (var kn = 1; kn <= 12; kn++) {
            ['A', 'B'].forEach(function (letter) {
                var kv = kn + letter;
                html += '<option value="' + kv + '"' + (tf.key === kv ? ' selected' : '') + '>' + kv + '</option>';
            });
        }
        html += '</select></div>';

        html += '<div class="track-filter-group"><label>Rating</label>';
        [0, 1, 2, 3, 4, 5].forEach(function (v) {
            var active = (parseInt(tf.minRating, 10) || 0) === v ? ' active' : '';
            var label = v === 0 ? 'Any' : (ratingStars(v));
            html += '<span class="rating-pill' + active + '" onclick="tSetFilter(\'minRating\', ' + v + ')">' + label + '</span>';
        });
        html += '</div>';

        html += '<button class="btn btn-clear" onclick="tClearFilters()">Reset</button>';
        html += '</div>';

        // Tag pills
        if (tagList.length > 0) {
            html += '<div class="genre-pills"><span class="filter-label">Tag:</span>';
            html += '<span class="genre-pill' + (!tf.tag ? ' active' : '') + '" onclick="tSetFilter(\'tag\',\'\')">All</span>';
            tagList.forEach(function (t) {
                html += '<span class="genre-pill' + (tf.tag === t ? ' active' : '') + '" onclick="tSetFilter(\'tag\',\'' + escJs(t) + '\')">' + escHtml(t) + '</span>';
            });
            html += '</div>';
        }

        // Sort bar
        html += '<div class="sort-bar"><span class="sort-label">Sort by:</span>';
        [['artist', 'Artist'], ['title', 'Title'], ['release', 'Release'], ['year', 'Year'], ['bpm', 'BPM'], ['rating', 'Rating']].forEach(function (pair) {
            html += '<span class="sort-option' + (sortKey === pair[0] ? ' active' : '') + '" onclick="tSetSort(\'' + pair[0] + '\')">' + pair[1] + '</span>';
        });
        html += '</div>';

        // Rows
        if (pageRows.length === 0) {
            html += '<div class="empty-state"><p class="empty-title">No tracks match.</p>' +
                '<p class="empty-subtitle">Adjust the filters or clear them to see everything.</p>' +
                '<button class="btn btn-primary" onclick="tClearFilters()">Clear filters</button></div>';
        } else {
            html += '<div class="video-list tracks-list">';
            pageRows.forEach(function (row) {
                html += '<div class="video-item track-row" data-youtube-id="' + escHtml(row.youtubeId) + '" data-title="' + escHtml(row.videoTitle) + '" data-artist="' + escHtml(row.artist) + '" data-cover="' + escHtml(row.cover) + '" data-release-id="' + row.releaseId + '" data-meta-id="' + escHtml(row.metaId) + '">' +
                    '<button class="play-btn" onclick="playTrack(this.parentElement)"><span class="play-icon">&#9654;</span></button>';
                if (row.cover) {
                    html += '<img class="track-thumb" src="' + escHtml(row.cover) + '" alt="" loading="lazy">';
                } else {
                    html += '<div class="track-thumb no-thumb">&#9898;</div>';
                }
                html += '<div class="track-info">' +
                    '<div class="track-title-line">' + escHtml(row.videoTitle) + '</div>' +
                    '<div class="track-sub-line">' +
                        '<span class="t-artist" onclick="navigate(\'release\',{releaseId:' + row.releaseId + '})">' + escHtml(row.artist) + '</span>' +
                        ' &middot; <span class="t-release" onclick="navigate(\'release\',{releaseId:' + row.releaseId + '})">' + escHtml(row.releaseTitle) + '</span>' +
                        (row.year ? ' <span class="t-year">(' + row.year + ')</span>' : '') +
                    '</div>' +
                    '</div>';

                html += '<span class="track-badges">';
                if (row.bpm != null) html += '<span class="track-badge badge-bpm">' + row.bpm + '</span>';
                if (row.key) html += '<span class="track-badge badge-key">' + escHtml(row.key) + '</span>';
                if (row.rating) html += '<span class="track-badge badge-rating">' + ratingStars(row.rating) + '</span>';
                if (row.shelf) html += '<span class="track-badge badge-shelf">' + escHtml(row.shelf) + '</span>';
                html += '</span>';

                html += '<button class="meta-btn add-btn" onclick="openAddToSetlistPopover(this)" title="Add to setlist">+</button>';
                html += '<button class="meta-btn" onclick="toggleTrackMetaEditor(\'' + row.metaId + '\')" title="Edit metadata">&#9998;</button>';
                html += '</div>';
                html += '<div class="track-meta-editor" id="editor-' + row.metaId + '" style="display:none;"></div>';
            });
            html += '</div>';

            // Pagination
            if (totalPages > 1) {
                html += '<div class="pagination">';
                if (page > 1) html += '<span class="page-link" onclick="tGoPage(' + (page - 1) + ')">&laquo; Prev</span>';
                for (var p = 1; p <= totalPages; p++) {
                    if (p === page) {
                        html += '<span class="page-link active">' + p + '</span>';
                    } else if (p <= 3 || p > totalPages - 3 || (p >= page - 2 && p <= page + 2)) {
                        html += '<span class="page-link" onclick="tGoPage(' + p + ')">' + p + '</span>';
                    } else if (p === 4 || p === totalPages - 3) {
                        html += '<span class="page-dots">...</span>';
                    }
                }
                if (page < totalPages) html += '<span class="page-link" onclick="tGoPage(' + (page + 1) + ')">Next &raquo;</span>';
                html += '</div>';
            }
        }

        document.getElementById('app').innerHTML = html;
    });
}

function tDoSearch() {
    var el = document.getElementById('tracks-search-input');
    _filters.tracks.q = el ? el.value.trim() : '';
    _filters.tracks.page = 1;
    renderTracks();
}
function tClearSearch() { _filters.tracks.q = ''; _filters.tracks.page = 1; renderTracks(); }
function tSetFilter(k, v) { _filters.tracks[k] = v; _filters.tracks.page = 1; renderTracks(); }
function tSetBpm(k, v) { _filters.tracks[k] = v; _filters.tracks.page = 1; renderTracks(); }
function tSetSort(s) { _filters.tracks.sort = s; renderTracks(); }
function tClearFilters() {
    _filters.tracks = { q: '', bpmMin: '', bpmMax: '', key: '', minRating: 0, tag: '', sort: 'artist', page: 1 };
    renderTracks();
}
function tGoPage(p) { _filters.tracks.page = p; renderTracks(); window.scrollTo(0, 0); }

// ============ Release Detail View ============

function renderRelease(releaseId) {
    Promise.all([
        dbGet('releases', releaseId),
        dbGetByIndex('videos', 'release_id', releaseId),
        dbGetByIndex('track_meta', 'release_id', releaseId),
        dbGetByIndex('tracklist', 'release_id', releaseId),
        dbGet('wants', releaseId)
    ]).then(function (results) {
        var r = results[0];
        var videos = results[1].sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
        var metaById = {};
        (results[2] || []).forEach(function (m) { metaById[m.id] = m; });
        var tracklistTracks = (results[3] || [])
            .filter(function (t) { return t.type !== 'heading'; })
            .sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
        var want = results[4];

        if (!r && want) {
            r = {
                id: want.id,
                title: want.title,
                artist: want.artist,
                year: want.year,
                cover_url: want.thumb_url || '',
                thumb_url: want.thumb_url || '',
                genres: want.genres ? (Array.isArray(want.genres) ? want.genres.join(', ') : want.genres) : '',
                format: want.formats ? (Array.isArray(want.formats) ? want.formats.join(', ') : want.formats) : '',
                _fromWantlist: true
            };
        }

        if (!r) { navigate('collection'); return; }

        var backView = r._fromWantlist ? 'wantlist' : 'collection';
        var backLabel = r._fromWantlist ? '&larr; Back to want list' : '&larr; Back to collection';
        var html = '<span class="back-link" onclick="navigate(\'' + backView + '\')">' + backLabel + '</span>';
        html += '<div class="release-detail"><div class="release-hero">';

        // Cover
        html += '<div class="release-cover-wrap">';
        if (r.cover_url) {
            html += '<img class="release-cover" src="' + escHtml(r.cover_url) + '" alt="">';
        } else {
            html += '<div class="no-cover-large"><span class="vinyl-icon-huge">&#9898;</span></div>';
        }
        html += '</div>';

        // Meta
        html += '<div class="release-meta">';
        html += '<h1 class="release-title">' + escHtml(r.title) + '</h1>';
        html += '<p class="release-artist">' + escHtml(r.artist) + '</p>';

        html += '<div class="meta-tags">';
        if (r.year) html += '<span class="meta-tag">' + r.year + '</span>';
        if (r.format) html += '<span class="meta-tag">' + escHtml(r.format) + '</span>';
        if (r.quantity > 1) html += '<span class="meta-tag meta-tag-qty">x' + r.quantity + '</span>';
        html += '</div>';

        if (r.genres) {
            html += '<div class="meta-genres">';
            r.genres.split(', ').forEach(function (g) {
                html += '<span class="genre-pill small">' + escHtml(g) + '</span>';
            });
            html += '</div>';
        }
        if (r.styles) {
            html += '<div class="meta-styles">';
            r.styles.split(', ').forEach(function (s) {
                html += '<span class="style-tag">' + escHtml(s) + '</span>';
            });
            html += '</div>';
        }

        html += '<a class="discogs-link" href="https://www.discogs.com/release/' + r.id + '" target="_blank" rel="noopener">View on Discogs &nearr;</a>';
        html += '</div>';

        html += '<div class="release-tracklist-col">';
        if (tracklistTracks.length > 0) {
            html += vinylTracklistHtml(tracklistTracks);
        } else {
            html += '<div id="vt-panel-' + r.id + '"></div>';
        }
        html += '</div></div>';

        // Videos
        html += '<div class="video-section"><div class="video-header"><h3>Tracklist</h3>';
        if (videos.length > 0) {
            html += '<button class="btn btn-play-all" onclick="playAllFromRelease(' + r.id + ')">&#9654; Play All</button>';
        }
        html += '</div>';

        if (videos.length > 0) {
            html += '<div class="video-list">';
            videos.forEach(function (vid) {
                var metaId = r.id + '_' + vid.youtube_id;
                var meta = metaById[metaId] || null;
                html += '<div class="video-item" data-youtube-id="' + escHtml(vid.youtube_id) + '" data-title="' + escHtml(vid.title) + '" data-artist="' + escHtml(r.artist) + '" data-cover="' + escHtml(r.thumb_url || '') + '" data-release-id="' + r.id + '" data-meta-id="' + escHtml(metaId) + '">' +
                    '<button class="play-btn" onclick="playTrack(this.parentElement)"><span class="play-icon">&#9654;</span></button>' +
                    '<div class="video-info"><span class="video-title">' + escHtml(vid.title) + '</span>';
                if (meta) {
                    html += '<span class="track-badges">';
                    if (meta.bpm != null && meta.bpm !== '') html += '<span class="track-badge badge-bpm">' + meta.bpm + ' BPM</span>';
                    if (meta.key) html += '<span class="track-badge badge-key">' + escHtml(meta.key) + '</span>';
                    if (meta.rating) html += '<span class="track-badge badge-rating">' + ratingStars(meta.rating) + '</span>';
                    if (meta.shelf) html += '<span class="track-badge badge-shelf">' + escHtml(meta.shelf) + '</span>';
                    html += '</span>';
                }
                if (vid.duration) {
                    html += '<span class="video-duration">' + escHtml(String(vid.duration)) + '</span>';
                }
                html += '</div>' +
                    '<button class="meta-btn add-btn" onclick="openAddToSetlistPopover(this)" title="Add to setlist">+</button>' +
                    '<button class="meta-btn" onclick="toggleTrackMetaEditor(\'' + metaId + '\')" title="Edit metadata">&#9998;</button>' +
                    '</div>' +
                    '<div class="track-meta-editor" id="editor-' + metaId + '" style="display:none;"></div>';
            });
            html += '</div>';
        } else {
            html += '<div class="no-videos-message"><p>No YouTube videos found for this release.</p>' +
                    '<p class="hint">Try syncing your collection to fetch video links.</p></div>';
        }
        html += '</div></div>';

        document.getElementById('app').innerHTML = html;
        if (tracklistTracks.length === 0) fetchTracklistLazy(releaseId);
    });
}

function vinylTracklistHtml(tracks) {
    var sides = {};
    var sideOrder = [];
    tracks.forEach(function (t) {
        var pos = (t.position || '').trim();
        var match = pos.match(/^([A-Za-z]+)/);
        var side = match ? match[1].toUpperCase() : '';
        if (!sides[side]) { sides[side] = []; sideOrder.push(side); }
        sides[side].push(t);
    });
    if (sideOrder.length === 0) return '';
    var hasSideLabels = sideOrder.some(function (s) { return s !== ''; });
    var html = '<div class="vinyl-tracklist">';
    sideOrder.forEach(function (side) {
        html += '<div class="vt-side">';
        if (hasSideLabels && side) {
            html += '<div class="vt-side-label">Side ' + escHtml(side) + '</div>';
        }
        sides[side].forEach(function (t) {
            html += '<div class="vt-track">' +
                '<span class="vt-pos">' + escHtml(t.position || '') + '</span>' +
                '<span class="vt-title">' + escHtml(t.title || '') + '</span>' +
                '<span class="vt-dur">' + escHtml(t.duration || '') + '</span>' +
                '</div>';
        });
        html += '</div>';
    });
    html += '</div>';
    return html;
}

async function fetchTracklistLazy(releaseId) {
    var panelEl = document.getElementById('vt-panel-' + releaseId);
    if (!panelEl) return;
    try {
        var config = await getConfig();
        if (!config.token) return;
        var data = await discogsGet('/releases/' + releaseId, config);
        var tracklistData = data.tracklist || [];
        for (var ti = 0; ti < tracklistData.length; ti++) {
            var tl = tracklistData[ti];
            await dbPut('tracklist', {
                id: releaseId + '_' + ti,
                release_id: releaseId,
                position: tl.position || '',
                title: tl.title || '',
                duration: tl.duration || '',
                type: tl.type_ || 'track',
                index: ti
            });
        }
        var rel = await dbGet('releases', releaseId);
        if (rel) { rel.tracklist_synced = true; await dbPut('releases', rel); }
        var displayTracks = tracklistData
            .filter(function (t) { return t.type_ !== 'heading'; })
            .map(function (t, i) {
                return { position: t.position || '', title: t.title || '', duration: t.duration || '', type: t.type_ || 'track', index: i };
            });
        if (panelEl) panelEl.innerHTML = vinylTracklistHtml(displayTracks);
    } catch (err) {
        console.error('Tracklist fetch failed:', err);
    }
}

// ============ Filter / Search Helpers ============

function doSearch() {
    var val = document.getElementById('search-input').value.trim();
    _filters.q = val;
    _filters.page = 1;
    renderCollection();
}

function clearSearch() {
    _filters.q = '';
    _filters.page = 1;
    renderCollection();
}

function setFilter(key, value) {
    _filters[key] = value;
    _filters.page = 1;
    renderCollection();
}

function setSort(s) {
    _filters.sort = s;
    _filters.page = 1;
    renderCollection();
}

function goPage(p) {
    _filters.page = p;
    renderCollection();
    window.scrollTo(0, 0);
}

function clearAllFilters() {
    _filters.q = '';
    _filters.genre = '';
    _filters.folder = '';
    _filters.country = '';
    _filters.page = 1;
    renderCollection();
}

// ============ Setlists ============

function createSetlist(name) {
    var now = new Date().toISOString();
    return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('setlists', 'readwrite');
            var req = tx.objectStore('setlists').add({
                name: name || 'Untitled setlist',
                created_at: now,
                updated_at: now,
                tracks: [],
                notes: ''
            });
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    });
}

function addTrackToSetlist(setlistId, track) {
    return dbGet('setlists', setlistId).then(function (sl) {
        if (!sl) return;
        sl.tracks = sl.tracks || [];
        sl.tracks.push({
            youtubeId: track.youtubeId,
            title: track.title,
            artist: track.artist || '',
            cover: track.cover || '',
            releaseId: track.releaseId || null,
            metaId: track.metaId || null
        });
        sl.updated_at = new Date().toISOString();
        return dbPut('setlists', sl).then(function () {
            showSyncBanner('Added to "' + sl.name + '"');
            setTimeout(hideSyncBanner, 1200);
        });
    });
}

function removeTrackFromSetlist(id, idx) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl) return;
        sl.tracks.splice(idx, 1);
        sl.updated_at = new Date().toISOString();
        dbPut('setlists', sl).then(function () { renderSetlist(id); });
    });
}

function moveSetlistTrack(id, fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    dbGet('setlists', id).then(function (sl) {
        if (!sl) return;
        var track = sl.tracks.splice(fromIdx, 1)[0];
        sl.tracks.splice(toIdx, 0, track);
        sl.updated_at = new Date().toISOString();
        dbPut('setlists', sl).then(function () { renderSetlist(id); });
    });
}

function initSetlistDragDrop(setlistId) {
    var rows = Array.prototype.slice.call(document.querySelectorAll('.setlist-tracklist .setlist-row'));
    var dragSrcIdx = null;

    function clearDragOver() {
        rows.forEach(function (r) { r.classList.remove('drag-over-above', 'drag-over-below'); });
    }

    rows.forEach(function (row, idx) {
        row.addEventListener('dragstart', function (e) {
            dragSrcIdx = idx;
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(function () { row.classList.add('dragging'); }, 0);
        });

        row.addEventListener('dragend', function () {
            row.classList.remove('dragging');
            clearDragOver();
        });

        row.addEventListener('dragover', function (e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            clearDragOver();
            var rect = row.getBoundingClientRect();
            if (e.clientY < rect.top + rect.height / 2) {
                row.classList.add('drag-over-above');
            } else {
                row.classList.add('drag-over-below');
            }
        });

        row.addEventListener('dragleave', function (e) {
            if (!row.contains(e.relatedTarget)) {
                row.classList.remove('drag-over-above', 'drag-over-below');
            }
        });

        row.addEventListener('drop', function (e) {
            e.preventDefault();
            clearDragOver();
            if (dragSrcIdx === null || dragSrcIdx === idx) return;
            var rect = row.getBoundingClientRect();
            var toIdx = (e.clientY < rect.top + rect.height / 2) ? idx : idx + 1;
            if (dragSrcIdx < toIdx) toIdx--;
            moveSetlistTrack(setlistId, dragSrcIdx, toIdx);
        });
    });
}

function renameSetlist(id, name) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl) return;
        var trimmed = (name || '').trim();
        if (!trimmed) return;
        sl.name = trimmed;
        sl.updated_at = new Date().toISOString();
        dbPut('setlists', sl);
    });
}

function saveSetlistNotes(id, notes) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl) return;
        sl.notes = notes || '';
        sl.updated_at = new Date().toISOString();
        dbPut('setlists', sl);
    });
}

function deleteSetlist(id) {
    if (!confirm('Delete this setlist? This cannot be undone.')) return;
    dbDelete('setlists', id).then(function () { navigate('setlists'); });
}

function promptNewSetlist() {
    var name = prompt('Name for new setlist:');
    if (!name) return;
    createSetlist(name.trim()).then(function (newId) {
        navigate('setlist', { setlistId: newId });
    });
}

// ------ Add-to-setlist popover ------

function openAddToSetlistPopover(btn) {
    closeAllPopovers();
    var row = btn.closest('.video-item');
    if (!row) return;
    var track = {
        youtubeId: row.dataset.youtubeId,
        title: row.dataset.title,
        artist: row.dataset.artist,
        cover: row.dataset.cover,
        releaseId: parseInt(row.dataset.releaseId, 10) || null,
        metaId: row.dataset.metaId || null
    };
    _openSetlistPopoverForTrack(btn, track);
}

// Opens the add-to-setlist popover for an arbitrary track object (not bound to a DOM row).
// Used both by openAddToSetlistPopover (from track list rows) and by the now-playing + button.
function _openSetlistPopoverForTrack(btn, track) {
    dbGetAll('setlists').then(function (setlists) {
        setlists.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
        var pop = document.createElement('div');
        pop.className = 'popover add-to-setlist-popover';
        var html = '<div class="popover-title">Add to setlist</div>';
        if (setlists.length === 0) {
            html += '<div class="popover-empty">No setlists yet</div>';
        } else {
            setlists.forEach(function (sl) {
                html += '<div class="popover-item" data-id="' + sl.id + '">' +
                    '<span class="popover-item-name">' + escHtml(sl.name) + '</span>' +
                    '<span class="popover-item-count">' + ((sl.tracks || []).length) + '</span>' +
                    '</div>';
            });
        }
        html += '<div class="popover-divider"></div>';
        html += '<div class="popover-item popover-new">+ New setlist...</div>';
        pop.innerHTML = html;
        document.body.appendChild(pop);

        // Position near button — above if the button is in the lower half of the viewport
        var rect = btn.getBoundingClientRect();
        pop.style.position = 'fixed';
        if (rect.top > window.innerHeight / 2) {
            pop.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
            pop.style.top = 'auto';
        } else {
            pop.style.top = (rect.bottom + 6) + 'px';
            pop.style.bottom = 'auto';
        }
        var left = rect.right - 240;
        if (left < 8) left = 8;
        if (left + 248 > window.innerWidth - 8) left = window.innerWidth - 256;
        pop.style.left = left + 'px';

        // Wire clicks
        pop.querySelectorAll('.popover-item[data-id]').forEach(function (el) {
            el.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = parseInt(el.getAttribute('data-id'), 10);
                addTrackToSetlist(id, track).then(closeAllPopovers);
            });
        });
        var newBtn = pop.querySelector('.popover-new');
        newBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var name = prompt('Name for new setlist:');
            if (!name) { closeAllPopovers(); return; }
            createSetlist(name.trim()).then(function (newId) {
                addTrackToSetlist(newId, track).then(closeAllPopovers);
            });
        });

        setTimeout(function () {
            document.addEventListener('click', _popoverOutsideHandler);
        }, 0);
    });
}

// + button on the now-playing bar: looks up releaseId/metaId via videos index then opens the setlist popover.
function openNowPlayingAddToSetlist(btn) {
    if (currentIndex < 0 || !currentQueue[currentIndex]) return;
    closeAllPopovers();
    var cur = currentQueue[currentIndex];
    dbGetByIndex('videos', 'youtube_id', cur.youtubeId).then(function (vids) {
        var vid = vids[0] || null;
        var track = {
            youtubeId: cur.youtubeId,
            title: cur.title,
            artist: cur.artist,
            cover: cur.cover,
            releaseId: vid ? vid.release_id : null,
            metaId: vid ? (vid.release_id + '_' + vid.youtube_id) : null
        };
        _openSetlistPopoverForTrack(btn, track);
    });
}

// ↗ button on the now-playing bar: navigates to the release for the current track.
function gotoNowPlayingRelease() {
    if (currentIndex < 0 || !currentQueue[currentIndex]) return;
    var cur = currentQueue[currentIndex];
    if (cur.releaseId) {
        navigate('release', { releaseId: cur.releaseId });
        return;
    }
    // Fallback for queue items persisted before releaseId was stored.
    dbGetByIndex('videos', 'youtube_id', cur.youtubeId).then(function (vids) {
        if (vids.length > 0) navigate('release', { releaseId: vids[0].release_id });
    });
}

function _popoverOutsideHandler(e) {
    var pop = document.querySelector('.popover');
    if (pop && !pop.contains(e.target)) closeAllPopovers();
}

function closeAllPopovers() {
    document.querySelectorAll('.popover').forEach(function (p) { p.remove(); });
    document.removeEventListener('click', _popoverOutsideHandler);
}

// ------ Setlists index view ------

function renderSetlists() {
    dbGetAll('setlists').then(function (setlists) {
        setlists.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
        var html = '<div class="collection-header"><div class="collection-stats">' +
            '<h1>Setlists</h1>' +
            '<span class="stat-count">' + setlists.length + ' setlist' + (setlists.length === 1 ? '' : 's') + '</span>' +
            '<button class="btn btn-primary" onclick="promptNewSetlist()">+ New Setlist</button>' +
            '</div></div>';
        if (setlists.length === 0) {
            html += '<div class="empty-state"><p class="empty-title">No setlists yet</p>' +
                '<p class="empty-subtitle">Create a setlist to prep your next gig</p>' +
                '<button class="btn btn-primary btn-large" onclick="promptNewSetlist()">+ New Setlist</button></div>';
        } else {
            html += '<div class="setlist-index">';
            setlists.forEach(function (sl) {
                var count = (sl.tracks || []).length;
                var updated = (sl.updated_at || '').substring(0, 10);
                html += '<div class="setlist-card" onclick="navigate(\'setlist\',{setlistId:' + sl.id + '})">' +
                    '<div class="setlist-card-name">' + escHtml(sl.name) + '</div>' +
                    '<div class="setlist-card-meta">' + count + ' track' + (count === 1 ? '' : 's') + ' &middot; updated ' + updated + '</div>' +
                    '</div>';
            });
            html += '</div>';
        }
        document.getElementById('app').innerHTML = html;
    });
}

// ------ Setlist detail view ------

function renderSetlist(setlistId) {
    if (!setlistId) { navigate('setlists'); return; }
    Promise.all([dbGet('setlists', setlistId), dbGetAll('track_meta')]).then(function (results) {
        var sl = results[0];
        if (!sl) { navigate('setlists'); return; }
        var metaById = {};
        results[1].forEach(function (m) { metaById[m.id] = m; });
        var tracks = sl.tracks || [];

        var html = '<span class="back-link" onclick="navigate(\'setlists\')">&larr; Back to setlists</span>';
        html += '<div class="setlist-detail">';
        html += '<div class="setlist-header">' +
            '<input type="text" class="setlist-name-input" value="' + escHtml(sl.name) + '" onchange="renameSetlist(' + sl.id + ', this.value)">' +
            '<div class="setlist-actions">' +
                '<button class="btn btn-play-all"' + (tracks.length === 0 ? ' disabled' : '') + ' onclick="playSetlist(' + sl.id + ')">&#9654; Play all</button>' +
                '<div class="setlist-export">' +
                    '<button class="btn"' + (tracks.length === 0 ? ' disabled' : '') + ' onclick="toggleExportMenu(' + sl.id + ')">Export &#9662;</button>' +
                    '<div class="export-menu popover" id="export-menu-' + sl.id + '" style="display:none;">' +
                        '<div class="popover-item" onclick="exportSetlistM3U(' + sl.id + ');toggleExportMenu(' + sl.id + ')">M3U playlist</div>' +
                        '<div class="popover-item" onclick="exportSetlistTxt(' + sl.id + ');toggleExportMenu(' + sl.id + ')">Plain text (.txt)</div>' +
                        '<div class="popover-item" onclick="exportSetlistCsv(' + sl.id + ');toggleExportMenu(' + sl.id + ')">CSV with BPM/key</div>' +
                    '</div>' +
                '</div>' +
                '<button class="btn btn-danger" onclick="deleteSetlist(' + sl.id + ')">Delete</button>' +
            '</div>' +
        '</div>';
        html += '<textarea class="setlist-notes" placeholder="Setlist notes (venue, vibe, intro track idea...)" onchange="saveSetlistNotes(' + sl.id + ', this.value)">' + escHtml(sl.notes || '') + '</textarea>';

        if (tracks.length === 0) {
            html += '<div class="empty-state"><p class="empty-title">Empty setlist</p>' +
                '<p class="empty-subtitle">Add tracks from Collection or All Tracks view using the + button</p></div>';
        } else {
            html += '<div class="video-list setlist-tracklist">';
            tracks.forEach(function (t, i) {
                var meta = metaById[t.metaId] || {};
                html += '<div class="video-item setlist-row" draggable="true" data-index="' + i + '" data-youtube-id="' + escHtml(t.youtubeId) + '" data-title="' + escHtml(t.title) + '" data-artist="' + escHtml(t.artist || '') + '" data-cover="' + escHtml(t.cover || '') + '" data-release-id="' + (t.releaseId || '') + '" data-meta-id="' + escHtml(t.metaId || '') + '">' +
                    '<span class="drag-handle" title="Drag to reorder">&#8942;</span>' +
                    '<span class="setlist-num">' + (i + 1) + '</span>' +
                    '<button class="play-btn" onclick="playFromSetlist(' + sl.id + ',' + i + ')"><span class="play-icon">&#9654;</span></button>';
                if (t.cover) {
                    html += '<img class="track-thumb" src="' + escHtml(t.cover) + '" alt="" loading="lazy">';
                } else {
                    html += '<div class="track-thumb no-thumb">&#9898;</div>';
                }
                html += '<div class="track-info">' +
                    '<div class="track-title-line">' + escHtml(t.title) + '</div>' +
                    '<div class="track-sub-line">' + escHtml(t.artist || '') + '</div>' +
                    '</div>';
                html += '<span class="track-badges">';
                if (meta.bpm != null) html += '<span class="track-badge badge-bpm">' + meta.bpm + '</span>';
                if (meta.key) html += '<span class="track-badge badge-key">' + escHtml(meta.key) + '</span>';
                if (meta.rating) html += '<span class="track-badge badge-rating">' + ratingStars(meta.rating) + '</span>';
                html += '</span>';
                html += '<button class="meta-btn" onclick="removeTrackFromSetlist(' + sl.id + ',' + i + ')" title="Remove">&times;</button>';
                html += '</div>';
            });
            html += '</div>';
        }
        html += '</div>';
        document.getElementById('app').innerHTML = html;
        if (tracks.length > 0) initSetlistDragDrop(sl.id);
    });
}

function playSetlist(id) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl || !sl.tracks || sl.tracks.length === 0) return;
        currentQueue = sl.tracks.map(function (t) {
            return { youtubeId: t.youtubeId, releaseId: t.releaseId || null, title: t.title, artist: t.artist || '', cover: t.cover || '' };
        });
        currentIndex = 0;
        loadFromQueue(0);
    });
}

function playFromSetlist(id, idx) {
    dbGet('setlists', id).then(function (sl) {
        if (!sl || !sl.tracks || sl.tracks.length === 0) return;
        currentQueue = sl.tracks.map(function (t) {
            return { youtubeId: t.youtubeId, releaseId: t.releaseId || null, title: t.title, artist: t.artist || '', cover: t.cover || '' };
        });
        currentIndex = idx;
        loadFromQueue(idx);
    });
}

// ------ Export ------

function toggleExportMenu(id) {
    var menu = document.getElementById('export-menu-' + id);
    if (!menu) return;
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function downloadBlob(filename, mime, content) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 0);
}

function slugifySetlist(s) {
    return (s || 'setlist').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'setlist';
}

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

// ============ YouTube Player ============

var player = null;
var playerReady = false;
var currentQueue = [];
var currentIndex = -1;
var isPlaying = false;
var _saveInterval = null;

// ---- Crossfade state ----
var player2 = null;
var player2Ready = false;
var cfEnabled = false;
var cfSeconds = 5;
var _cfState = 'idle';        // 'idle' | 'preloaded' | 'fading' | 'switching'
var _cfPreloadedIndex = -1;
var _cfFadeInterval = null;
var _cfCheckInterval = null;

// Load YouTube IFrame API
var ytTag = document.createElement('script');
ytTag.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(ytTag);

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player-container', {
        height: '200',
        width: '356',
        playerVars: { autoplay: 0, controls: 1, modestbranding: 1, rel: 0 },
        events: {
            onReady: function () {
                playerReady = true;
                _restorePlayerState();
            },
            onStateChange: onPlayerStateChange,
        },
    });
    player2 = new YT.Player('player2-container', {
        height: '1',
        width: '1',
        playerVars: { autoplay: 0, controls: 0, modestbranding: 1, rel: 0 },
        events: {
            onReady: function () { player2Ready = true; },
            onStateChange: onPlayer2StateChange,
        },
    });
}

function onPlayerStateChange(event) {
    if (event.data === YT.PlayerState.ENDED) {
        // Ignore ENDED while crossfade is actively fading or switching players
        if (_cfState === 'fading' || _cfState === 'switching') return;
        // Clean up unused preload if track ended before crossfade could start
        if (_cfState === 'preloaded') _abortCrossfade();
        if (currentIndex < currentQueue.length - 1) {
            currentIndex++;
            loadFromQueue(currentIndex);
            if (document.getElementById('queue-panel')) _renderQueuePanel();
        } else {
            isPlaying = false;
            stopViz();
            updatePlayPauseBtn();
        }
    } else if (event.data === YT.PlayerState.PLAYING) {
        // Complete crossfade handoff: player1 is now playing the new track
        if (_cfState === 'switching') {
            player.setVolume(100);
            try { player2.pauseVideo(); player2.setVolume(0); } catch (e) {}
            _cfState = 'idle';
            _cfPreloadedIndex = -1;
            isPlaying = true;
            updatePlayPauseBtn();
            _savePlayerState();
            if (cfEnabled) setTimeout(_preloadNextTrack, 800);
            if (document.getElementById('queue-panel')) _renderQueuePanel();
            return;
        }
        isPlaying = true;
        startViz();
        updatePlayPauseBtn();
        _savePlayerState();
    } else if (event.data === YT.PlayerState.PAUSED) {
        isPlaying = false;
        stopViz();
        updatePlayPauseBtn();
        _savePlayerState();
    }
}

function updatePlayPauseBtn() {
    var btn = document.getElementById('np-play-pause');
    if (btn) btn.innerHTML = isPlaying ? '&#10074;&#10074;' : '&#9654;';
}

function showNowPlaying(title, artist, coverUrl) {
    var bar = document.getElementById('now-playing');
    document.getElementById('np-title').textContent = title;
    document.getElementById('np-artist').textContent = artist || '';
    var cover = document.getElementById('np-cover');
    if (coverUrl) { cover.src = coverUrl; cover.style.display = 'block'; }
    else { cover.style.display = 'none'; }
    bar.style.display = 'flex';
    document.body.style.paddingBottom = '220px';
    highlightActiveTrack();
}

function hideNowPlaying() {
    stopViz();
    document.getElementById('now-playing').style.display = 'none';
    document.body.style.paddingBottom = '0';
    if (player && playerReady) player.stopVideo();
    isPlaying = false;
    currentQueue = [];
    currentIndex = -1;
    sessionStorage.removeItem('playerState');
    highlightActiveTrack();
    closeSuggestions();
    closeQueue();
}

function highlightActiveTrack() {
    document.querySelectorAll('.video-item').forEach(function (el) { el.classList.remove('playing'); });
    if (currentIndex >= 0 && currentQueue[currentIndex]) {
        var ytId = currentQueue[currentIndex].youtubeId;
        document.querySelectorAll('.video-item').forEach(function (el) {
            if (el.dataset.youtubeId === ytId) el.classList.add('playing');
        });
    }
}

function loadFromQueue(index) {
    var item = currentQueue[index];
    if (!item || !playerReady) return;
    if (_cfState !== 'idle') _abortCrossfade();
    player.setVolume(100);
    player.loadVideoById(item.youtubeId);
    showNowPlaying(item.title, item.artist, item.cover);
    isPlaying = true;
    updatePlayPauseBtn();
    _savePlayerState();
    if (cfEnabled) {
        _cfState = 'idle';
        _cfPreloadedIndex = -1;
        setTimeout(_preloadNextTrack, 800);
    }
}

function playTrack(element) {
    if (!playerReady) return;
    var allItems = document.querySelectorAll('.video-item');
    currentQueue = [];
    var startIndex = 0;
    allItems.forEach(function (el, i) {
        currentQueue.push({
            youtubeId: el.dataset.youtubeId,
            releaseId: el.dataset.releaseId || null,
            title: el.dataset.title,
            artist: el.dataset.artist || '',
            cover: el.dataset.cover || '',
        });
        if (el === element) startIndex = i;
    });
    currentIndex = startIndex;
    loadFromQueue(currentIndex);
}

function playAll() {
    var allItems = document.querySelectorAll('.video-item');
    if (allItems.length === 0) return;
    currentQueue = [];
    allItems.forEach(function (el) {
        currentQueue.push({
            youtubeId: el.dataset.youtubeId,
            releaseId: el.dataset.releaseId || null,
            title: el.dataset.title,
            artist: el.dataset.artist || '',
            cover: el.dataset.cover || '',
        });
    });
    currentIndex = 0;
    loadFromQueue(0);
}

function playAllFromRelease(releaseId) {
    dbGetByIndex('videos', 'release_id', releaseId).then(function (videos) {
        if (videos.length === 0) return;
        return dbGet('releases', releaseId).then(function (r) {
            videos.sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
            currentQueue = videos.map(function (v) {
                return {
                    youtubeId: v.youtube_id,
                    title: v.title,
                    artist: r ? r.artist : '',
                    cover: r ? (r.thumb_url || '') : '',
                };
            });
            currentIndex = 0;
            loadFromQueue(0);
        });
    });
}

function shufflePlay(limitOverride) {
    if (!playerReady) return;
    dbGetAll('releases').then(function (allReleases) {
        // Apply current filters
        var filtered = allReleases;
        var q = (_filters.q || '').toLowerCase();
        if (q) filtered = filtered.filter(function (r) {
            return r.artist.toLowerCase().indexOf(q) !== -1 || r.title.toLowerCase().indexOf(q) !== -1;
        });
        if (_filters.genre) filtered = filtered.filter(function (r) {
            return r.genres && r.genres.indexOf(_filters.genre) !== -1;
        });
        if (_filters.folder) {
            var fid = parseInt(_filters.folder);
            filtered = filtered.filter(function (r) {
                return r.folder_ids && r.folder_ids.indexOf(fid) !== -1;
            });
        }
        if (_filters.country) {
            filtered = filtered.filter(function (r) {
                return r.country === _filters.country;
            });
        }

        var ids = filtered.map(function (r) { return r.id; });
        if (ids.length === 0) { alert('No releases match the current filters.'); return; }

        // Fetch all videos for these releases
        dbGetAll('videos').then(function (allVideos) {
            var matchingVideos = allVideos.filter(function (v) {
                return v.youtube_id && ids.indexOf(v.release_id) !== -1;
            });
            if (matchingVideos.length === 0) { alert('No videos found. Try syncing first.'); return; }

            // Build release lookup
            var relMap = {};
            filtered.forEach(function (r) { relMap[r.id] = r; });

            // Shuffle (Fisher-Yates)
            for (var i = matchingVideos.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = matchingVideos[i];
                matchingVideos[i] = matchingVideos[j];
                matchingVideos[j] = tmp;
            }

            // Determine limit
            var limit;
            if (typeof limitOverride === 'number') {
                limit = limitOverride;
            } else {
                var inputEl = document.getElementById('shuffle-count');
                var parsed = inputEl ? parseInt(inputEl.value, 10) : NaN;
                limit = (!isNaN(parsed) && parsed >= 1) ? parsed : 50;
            }
            var selected = (limit === Infinity || limit >= matchingVideos.length)
                ? matchingVideos
                : matchingVideos.slice(0, limit);
            currentQueue = selected.map(function (v) {
                var r = relMap[v.release_id] || {};
                return {
                    youtubeId: v.youtube_id,
                    title: v.title,
                    artist: r.artist || '',
                    cover: r.thumb_url || '',
                };
            });
            currentIndex = 0;
            loadFromQueue(0);
            _renderQueuePanel();  // Auto-open queue so the shuffled list is immediately visible
        });
    });
}

function shufflePlayAll() {
    shufflePlay(Infinity);
}

// ============ Crossfade ============

function _loadCrossfadeSettings() {
    Promise.all([
        dbGet('config', 'crossfade_enabled'),
        dbGet('config', 'crossfade_seconds')
    ]).then(function (results) {
        cfEnabled = results[0] ? results[0].value === true : false;
        cfSeconds = results[1] ? (parseInt(results[1].value, 10) || 5) : 5;
        _updateCfUI();
        if (cfEnabled) _startCfCheckInterval();
    });
}

function _saveCrossfadeSettings() {
    dbPut('config', { key: 'crossfade_enabled', value: cfEnabled });
    dbPut('config', { key: 'crossfade_seconds', value: cfSeconds });
}

function _updateCfUI() {
    var btn = document.getElementById('np-cf-toggle');
    var inp = document.getElementById('np-cf-seconds');
    if (!btn || !inp) return;
    btn.textContent = cfEnabled ? 'CF: ON' : 'CF: OFF';
    if (cfEnabled) {
        btn.classList.add('active');
        inp.style.display = '';
    } else {
        btn.classList.remove('active');
        inp.style.display = 'none';
    }
    inp.value = cfSeconds;
}

function _startCfCheckInterval() {
    if (_cfCheckInterval) return;
    _cfCheckInterval = setInterval(_checkCrossfade, 500);
}

function _stopCfCheckInterval() {
    clearInterval(_cfCheckInterval);
    _cfCheckInterval = null;
}

function _checkCrossfade() {
    if (!cfEnabled || _cfState !== 'preloaded') return;
    if (!playerReady || !player2Ready) return;
    try {
        var duration = player.getDuration();
        var currentTime = player.getCurrentTime();
        if (duration <= 0) return;
        if (duration < cfSeconds + 2) return;
        var timeLeft = duration - currentTime;
        if (timeLeft > 0 && timeLeft <= cfSeconds) {
            _startCrossfade();
        }
    } catch (e) {}
}

function _preloadNextTrack() {
    var nextIndex = currentIndex + 1;
    if (nextIndex >= currentQueue.length) {
        _cfState = 'idle';
        _cfPreloadedIndex = -1;
        return;
    }
    if (!player2Ready) return;
    var nextItem = currentQueue[nextIndex];
    try {
        player2.cueVideoById(nextItem.youtubeId);
        _cfPreloadedIndex = nextIndex;
        _cfState = 'preloaded';
    } catch (e) {}
}

function _startCrossfade() {
    _cfState = 'fading';
    var startVol = 100;
    try { startVol = player.getVolume(); } catch (e) {}
    try {
        player2.setVolume(0);
        player2.playVideo();
    } catch (e) { _abortCrossfade(); return; }
    var steps = Math.ceil(cfSeconds * 1000 / 50);
    var tick = 0;
    _cfFadeInterval = setInterval(function () {
        tick++;
        var ratio = tick / steps;
        var vol1 = Math.round(startVol * (1 - ratio));
        var vol2 = Math.round(100 * ratio);
        try { player.setVolume(vol1); } catch (e) {}
        try { player2.setVolume(vol2); } catch (e) {}
        if (tick >= steps) {
            clearInterval(_cfFadeInterval);
            _cfFadeInterval = null;
            _completeCrossfade();
        }
    }, 50);
}

function _completeCrossfade() {
    _cfState = 'switching';
    var p2Time = 0;
    try { p2Time = player2.getCurrentTime() || 0; } catch (e) {}
    currentIndex = _cfPreloadedIndex;
    var item = currentQueue[currentIndex];
    showNowPlaying(item.title, item.artist, item.cover);
    try {
        player.setVolume(0);
        player.loadVideoById({ videoId: item.youtubeId, startSeconds: p2Time });
    } catch (e) {}
    // Volume restore + player2 stop happen in onPlayerStateChange when player1 fires PLAYING
}

function _abortCrossfade() {
    if (_cfFadeInterval) { clearInterval(_cfFadeInterval); _cfFadeInterval = null; }
    try { player2.pauseVideo(); player2.setVolume(0); } catch (e) {}
    try { player.setVolume(100); } catch (e) {}
    _cfState = 'idle';
    _cfPreloadedIndex = -1;
}

function onPlayer2StateChange(event) {
    if (event.data === YT.PlayerState.ENDED && _cfState === 'fading') {
        _abortCrossfade();
    }
}

// ============ Player State Persistence ============

function _savePlayerState() {
    if (currentQueue.length === 0) return;
    var currentTime = 0;
    try { currentTime = player.getCurrentTime() || 0; } catch (e) {}
    sessionStorage.setItem('playerState', JSON.stringify({
        queue: currentQueue,
        currentIndex: currentIndex,
        currentTime: currentTime,
        isPlaying: isPlaying,
    }));
}

function _restorePlayerState() {
    var raw = sessionStorage.getItem('playerState');
    if (!raw) return;
    try {
        var state = JSON.parse(raw);
        if (!state.queue || state.queue.length === 0) return;
        currentQueue = state.queue;
        currentIndex = state.currentIndex || 0;
        var item = currentQueue[currentIndex];
        if (!item) return;
        showNowPlaying(item.title, item.artist, item.cover);
        if (state.isPlaying) {
            player.loadVideoById({ videoId: item.youtubeId, startSeconds: state.currentTime || 0 });
            isPlaying = true;
        } else {
            player.cueVideoById({ videoId: item.youtubeId, startSeconds: state.currentTime || 0 });
            isPlaying = false;
        }
        updatePlayPauseBtn();
        if (cfEnabled && state.isPlaying) setTimeout(_preloadNextTrack, 1200);
    } catch (e) { console.warn('Failed to restore player state:', e); }
}

// ============ Music Visualizer ============

var vizCanvas = null;
var vizCtx = null;
var vizAnimFrame = null;
var vizType = 'bars';
var vizTime = 0;
var vizParticles = [];
var vizActive = false;

function initViz() {
    vizCanvas = document.getElementById('viz-canvas');
    if (!vizCanvas) return;
    vizCtx = vizCanvas.getContext('2d');
    vizParticles = [];
    for (var i = 0; i < 180; i++) {
        vizParticles.push(_newParticle(vizCanvas.width, vizCanvas.height));
    }
    document.querySelectorAll('.viz-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            vizType = this.dataset.viz;
            document.querySelectorAll('.viz-btn').forEach(function (b) { b.classList.remove('active'); });
            this.classList.add('active');
        });
    });
}

function _newParticle(w, h) {
    var angle = Math.random() * Math.PI * 2;
    var speed = 0.3 + Math.random() * 1.2;
    return {
        x: w / 2, y: h / 2,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: Math.random(),
        maxLife: 0.4 + Math.random() * 0.6,
        hue: Math.floor(Math.random() * 360),
        size: 1 + Math.random() * 2,
    };
}

function startViz() {
    if (vizActive) return;
    if (!vizCanvas) initViz();
    if (!vizCanvas) return;
    vizActive = true;
    _vizLoop();
}

function stopViz() {
    vizActive = false;
    if (vizAnimFrame) { cancelAnimationFrame(vizAnimFrame); vizAnimFrame = null; }
    if (vizCtx && vizCanvas) vizCtx.clearRect(0, 0, vizCanvas.width, vizCanvas.height);
}

function _vizLoop() {
    if (!vizActive) return;
    vizTime += 0.016;
    // Natural beat pulse: ~2 Hz sine gives a 120-BPM-equivalent pulsing feel
    var vizBeat = 0.5 + 0.5 * Math.sin(vizTime * 2.0 * Math.PI);
    var w = vizCanvas.width;
    var h = vizCanvas.height;

    if      (vizType === 'bars')      { _drawBars(w, h, vizBeat); }
    else if (vizType === 'wave')      { _drawWave(w, h, vizBeat); }
    else if (vizType === 'particles') { _drawParticles(w, h, vizBeat); }
    else if (vizType === 'rings')     { _drawRings(w, h, vizBeat); }
    else if (vizType === 'aurora')    { _drawAurora(w, h, vizBeat); }
    else if (vizType === 'helix')     { _drawHelix(w, h, vizBeat); }
    else if (vizType === 'lissajous') { _drawLissajous(w, h, vizBeat); }
    else if (vizType === 'tunnel')    { _drawTunnel(w, h, vizBeat); }

    vizAnimFrame = requestAnimationFrame(_vizLoop);
}

// VIZ 1 — Neon Spectrum Bars
function _drawBars(w, h, beat) {
    var ctx = vizCtx;
    // Fade trail
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, w, h);

    var numBars = 56;
    var gap = 2;
    var barW = (w - (numBars - 1) * gap) / numBars;
    var centerY = h / 2;

    for (var i = 0; i < numBars; i++) {
        var t = i / numBars;
        // Three overlapping sines per bar give a spectrum-like variation
        var v1 = Math.sin(vizTime * 1.7 + i * 0.45) * 0.5 + 0.5;
        var v2 = Math.sin(vizTime * 3.1 + i * 0.72) * 0.3;
        var v3 = Math.sin(vizTime * 0.9 + i * 1.1) * 0.2;
        var barH = Math.max(3, (v1 + v2 + v3) * centerY * 0.82 * (0.7 + beat * 0.6));

        var hue = 180 + t * 120; // cyan (180) → magenta (300)
        var x = i * (barW + gap);

        ctx.save();
        ctx.shadowBlur = 14;
        ctx.shadowColor = 'hsl(' + hue + ',100%,70%)';
        ctx.fillStyle = 'hsl(' + hue + ',100%,62%)';
        ctx.fillRect(x, centerY - barH, barW, barH);
        // Dimmer reflection below
        ctx.fillStyle = 'hsl(' + hue + ',100%,38%)';
        ctx.fillRect(x, centerY, barW, barH * 0.55);
        ctx.restore();
    }
}

// VIZ 2 — Plasma Sine Waves
function _drawWave(w, h, beat) {
    var ctx = vizCtx;
    ctx.clearRect(0, 0, w, h);
    var ampScale = h * 0.35 * (0.7 + beat * 0.6);
    var waves = [
        { amp: 0.9, freq: 2.1, speed: 0.9,  phase: 0,           hue: 190, alpha: 0.9, lw: 2.5 },
        { amp: 0.6, freq: 3.5, speed: 1.4,  phase: Math.PI / 3,  hue: 280, alpha: 0.7, lw: 1.8 },
        { amp: 0.7, freq: 1.8, speed: 0.6,  phase: Math.PI,      hue: 140, alpha: 0.65, lw: 2.0 },
    ];
    waves.forEach(function (wave) {
        ctx.save();
        ctx.beginPath();
        for (var x = 0; x <= w; x += 2) {
            var xn = x / w;
            var y = h / 2 + Math.sin(xn * wave.freq * Math.PI * 2 + vizTime * wave.speed + wave.phase) * ampScale * wave.amp;
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'hsla(' + wave.hue + ',100%,65%,' + wave.alpha + ')';
        ctx.lineWidth = wave.lw;
        ctx.shadowBlur = 18;
        ctx.shadowColor = 'hsl(' + wave.hue + ',100%,70%)';
        ctx.stroke();
        ctx.restore();
    });
}

// VIZ 3 — Starfield Particles
function _drawParticles(w, h, beat) {
    var ctx = vizCtx;
    // Dark fade trail
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, w, h);

    var speedMult = 1 + beat * 2.5;
    for (var i = 0; i < vizParticles.length; i++) {
        var p = vizParticles[i];
        p.x += p.vx * speedMult;
        p.y += p.vy * speedMult;
        p.life += 0.013;
        if (p.life > p.maxLife || p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
            vizParticles[i] = _newParticle(w, h);
            continue;
        }
        var alpha = Math.max(0, 1 - p.life / p.maxLife);
        ctx.save();
        ctx.shadowBlur = 8 + beat * 10;
        ctx.shadowColor = 'hsl(' + p.hue + ',100%,70%)';
        ctx.fillStyle = 'hsla(' + p.hue + ',100%,70%,' + alpha + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.8 + beat * 0.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

// VIZ 4 — Pulse Rings
function _drawRings(w, h, beat) {
    var ctx = vizCtx;
    ctx.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2;
    var maxR = Math.min(w, h) * 0.44;
    var numRings = 6;

    for (var i = 0; i < numRings; i++) {
        var t = ((vizTime * 0.12 + i / numRings) % 1);
        var r = t * maxR * (1 + beat * 0.35);
        var hue = (vizTime * 35 + i * 55) % 360;
        var alpha = (1 - t) * 0.92;
        var lw = 1.5 + (1 - t) * 4.5;

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
        ctx.strokeStyle = 'hsla(' + hue + ',100%,65%,' + alpha + ')';
        ctx.lineWidth = lw;
        ctx.shadowBlur = 22 + beat * 18;
        ctx.shadowColor = 'hsl(' + hue + ',100%,70%)';
        ctx.stroke();
        ctx.restore();
    }
    // Central glowing dot
    var innerR = 6 + beat * 18;
    var grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, innerR + 4);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.5, 'rgba(0,229,255,0.6)');
    grd.addColorStop(1, 'rgba(0,229,255,0)');
    ctx.save();
    ctx.shadowBlur = 30;
    ctx.shadowColor = '#00e5ff';
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.restore();
}

// VIZ 5 — Aurora Borealis
function _drawAurora(w, h, beat) {
    var ctx = vizCtx;
    ctx.clearRect(0, 0, w, h);
    var bands = [
        { yBase: 0.20, amp: 0.07, speed: 0.40, phase: 0.0, hue: 150 },
        { yBase: 0.36, amp: 0.08, speed: 0.28, phase: 1.2, hue: 185 },
        { yBase: 0.52, amp: 0.09, speed: 0.50, phase: 2.4, hue: 270 },
        { yBase: 0.68, amp: 0.07, speed: 0.34, phase: 0.8, hue: 310 },
        { yBase: 0.84, amp: 0.06, speed: 0.44, phase: 1.8, hue: 200 },
    ];
    bands.forEach(function (band) {
        var bandH = h * 0.20 * (1 + beat * 0.3);
        ctx.save();
        ctx.beginPath();
        for (var x = 0; x <= w; x += 3) {
            var yTop = h * band.yBase + Math.sin(x * 0.010 + vizTime * band.speed + band.phase) * h * band.amp * (0.8 + beat * 0.4) - bandH * 0.5;
            if (x === 0) ctx.moveTo(x, yTop); else ctx.lineTo(x, yTop);
        }
        for (var x2 = w; x2 >= 0; x2 -= 3) {
            var yBot = h * band.yBase + Math.sin(x2 * 0.010 + vizTime * band.speed + band.phase) * h * band.amp * (0.8 + beat * 0.4) + bandH * 0.5;
            ctx.lineTo(x2, yBot);
        }
        ctx.closePath();
        var midY = h * band.yBase;
        var grad = ctx.createLinearGradient(0, midY - bandH * 0.5, 0, midY + bandH * 0.5);
        grad.addColorStop(0,   'hsla(' + band.hue + ',100%,65%,0)');
        grad.addColorStop(0.4, 'hsla(' + band.hue + ',100%,65%,0.72)');
        grad.addColorStop(0.6, 'hsla(' + band.hue + ',100%,65%,0.72)');
        grad.addColorStop(1,   'hsla(' + band.hue + ',100%,65%,0)');
        ctx.fillStyle = grad;
        ctx.shadowBlur = 14 + beat * 14;
        ctx.shadowColor = 'hsl(' + band.hue + ',100%,70%)';
        ctx.fill();
        ctx.restore();
    });
}

// VIZ 6 — DNA Helix
function _drawHelix(w, h, beat) {
    var ctx = vizCtx;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, 0, w, h);
    var cy = h / 2;
    var amp = h * 0.33 * (1 + beat * 0.18);
    var freq = 3.5;
    var rot = vizTime * 0.8;
    var numRungs = 22;
    // Rungs (drawn first, behind strands)
    for (var i = 0; i <= numRungs; i++) {
        var t = i / numRungs;
        var x = t * w;
        var phase = t * freq * Math.PI * 2 + rot;
        var y1 = cy + Math.sin(phase) * amp;
        var y2 = cy + Math.sin(phase + Math.PI) * amp;
        var z = Math.sin(phase);
        var rungAlpha = 0.18 + 0.45 * (z * 0.5 + 0.5);
        var rungHue = (vizTime * 40 + i * 16) % 360;
        ctx.save();
        ctx.strokeStyle = 'hsla(' + rungHue + ',100%,70%,' + rungAlpha + ')';
        ctx.lineWidth = 1.5;
        ctx.shadowBlur = 6;
        ctx.shadowColor = 'hsl(' + rungHue + ',100%,70%)';
        ctx.beginPath();
        ctx.moveTo(x, y1);
        ctx.lineTo(x, y2);
        ctx.stroke();
        ctx.restore();
    }
    // Strand 1 — cyan
    ctx.save();
    ctx.beginPath();
    for (var x = 0; x <= w; x += 2) {
        var y = cy + Math.sin((x / w) * freq * Math.PI * 2 + rot) * amp;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'hsla(190,100%,65%,0.92)';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 16;
    ctx.shadowColor = '#00e5ff';
    ctx.stroke();
    ctx.restore();
    // Strand 2 — magenta
    ctx.save();
    ctx.beginPath();
    for (var x = 0; x <= w; x += 2) {
        var y = cy + Math.sin((x / w) * freq * Math.PI * 2 + rot + Math.PI) * amp;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'hsla(310,100%,65%,0.92)';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 16;
    ctx.shadowColor = '#ff00cc';
    ctx.stroke();
    ctx.restore();
    // Glowing nodes on each strand
    for (var i = 0; i <= 28; i++) {
        var t = i / 28;
        var x = t * w;
        var phase = t * freq * Math.PI * 2 + rot;
        var z = Math.sin(phase);
        var dotR = 1.5 + Math.max(0, z) * 3;
        if (dotR < 0.5) continue;
        ctx.save();
        ctx.shadowBlur = 10; ctx.shadowColor = '#00e5ff';
        ctx.fillStyle = 'rgba(0,229,255,0.9)';
        ctx.beginPath(); ctx.arc(x, cy + Math.sin(phase) * amp, dotR, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.shadowBlur = 10; ctx.shadowColor = '#ff00cc';
        ctx.fillStyle = 'rgba(255,0,204,0.9)';
        ctx.beginPath(); ctx.arc(x, cy + Math.sin(phase + Math.PI) * amp, dotR, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }
}

// VIZ 7 — Lissajous Curves
function _drawLissajous(w, h, beat) {
    var ctx = vizCtx;
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.fillRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2;
    var rx = w * 0.44;
    var ry = h * 0.42;
    var a = 3;
    var b = 2 + Math.sin(vizTime * 0.07) * 0.9;
    var delta = vizTime * 0.22;
    var hueBase = (vizTime * 18) % 360;
    var numPts = 700;
    // Primary curve
    ctx.save();
    ctx.beginPath();
    for (var i = 0; i <= numPts; i++) {
        var t = (i / numPts) * Math.PI * 2;
        var x = cx + rx * Math.sin(a * t + delta);
        var y = cy + ry * Math.sin(b * t);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'hsla(' + hueBase + ',100%,65%,0.75)';
    ctx.lineWidth = 1.8;
    ctx.shadowBlur = 12 + beat * 16;
    ctx.shadowColor = 'hsl(' + hueBase + ',100%,70%)';
    ctx.stroke();
    ctx.restore();
    // Inner complementary curve
    ctx.save();
    ctx.beginPath();
    var hue2 = (hueBase + 160) % 360;
    for (var i = 0; i <= numPts; i++) {
        var t = (i / numPts) * Math.PI * 2;
        var x = cx + rx * 0.55 * Math.sin(a * 2 * t + delta * 1.4);
        var y = cy + ry * 0.55 * Math.sin(b * 1.5 * t);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'hsla(' + hue2 + ',100%,65%,0.5)';
    ctx.lineWidth = 1.2;
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'hsl(' + hue2 + ',100%,70%)';
    ctx.stroke();
    ctx.restore();
}

// VIZ 8 — Neon Tunnel
function _drawTunnel(w, h, beat) {
    var ctx = vizCtx;
    ctx.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2;
    var numRings = 14;
    var tOffset = (vizTime * (0.09 + beat * 0.04)) % (1 / numRings);
    for (var i = numRings; i >= 0; i--) {
        var t = ((i / numRings) + tOffset) % 1;
        var rw = t * w * 0.52;
        var rh = t * h * 0.52;
        if (rw < 1 || rh < 1) continue;
        var hue = (vizTime * 55 + i * 26) % 360;
        var alpha = (1 - t) * 0.88 + 0.04;
        var lw = 0.8 + (1 - t) * 3.2;
        var angle = t * Math.PI * 0.25 + vizTime * 0.18;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.rect(-rw, -rh, rw * 2, rh * 2);
        ctx.strokeStyle = 'hsla(' + hue + ',100%,65%,' + alpha + ')';
        ctx.lineWidth = lw;
        ctx.shadowBlur = 14 + beat * 22;
        ctx.shadowColor = 'hsl(' + hue + ',100%,70%)';
        ctx.stroke();
        ctx.restore();
    }
    // Crosshair at vanishing point
    ctx.save();
    ctx.strokeStyle = 'hsla(190,100%,82%,0.85)';
    ctx.lineWidth = 1;
    ctx.shadowBlur = 12;
    ctx.shadowColor = '#00e5ff';
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
    ctx.stroke();
    ctx.restore();
}

// ============ Track Metadata Editor ============

function toggleTrackMetaEditor(metaId) {
    var panel = document.getElementById('editor-' + metaId);
    if (!panel) return;
    if (panel.style.display === 'none') {
        renderTrackMetaEditor(panel, metaId);
        panel.style.display = 'block';
    } else {
        panel.style.display = 'none';
    }
}

function renderTrackMetaEditor(panel, metaId) {
    var idx = metaId.indexOf('_');
    var releaseId = parseInt(metaId.substring(0, idx), 10);
    var youtubeId = metaId.substring(idx + 1);
    getTrackMeta(metaId).then(function (meta) {
        meta = meta || {};
        var camelots = [];
        for (var n = 1; n <= 12; n++) { camelots.push(n + 'A'); camelots.push(n + 'B'); }
        var keyOptions = '<option value="">&mdash;</option>';
        for (var ki = 0; ki < camelots.length; ki++) {
            var k = camelots[ki];
            keyOptions += '<option value="' + k + '"' + (meta.key === k ? ' selected' : '') + '>' + k + '</option>';
        }
        var ratingOptions = '';
        for (var rv = 0; rv <= 5; rv++) {
            var label = rv === 0 ? '&mdash;' : ratingStars(rv);
            ratingOptions += '<option value="' + rv + '"' + ((meta.rating || 0) === rv ? ' selected' : '') + '>' + label + '</option>';
        }
        var tagsStr = (meta.tags || []).join(', ');
        var id = metaId;
        panel.innerHTML =
            '<div class="meta-grid">' +
            '<label class="meta-field"><span>BPM</span><input type="number" step="0.1" min="40" max="220" id="mf-bpm-' + id + '" value="' + (meta.bpm != null ? meta.bpm : '') + '"></label>' +
            '<label class="meta-field"><span>Key (Camelot)</span><select id="mf-key-' + id + '">' + keyOptions + '</select></label>' +
            '<label class="meta-field"><span>Rating</span><select id="mf-rating-' + id + '">' + ratingOptions + '</select></label>' +
            '<label class="meta-field"><span>Energy 1-10</span><input type="number" min="1" max="10" id="mf-energy-' + id + '" value="' + (meta.energy != null ? meta.energy : '') + '"></label>' +
            '<label class="meta-field"><span>Shelf</span><input type="text" id="mf-shelf-' + id + '" value="' + escHtml(meta.shelf || '') + '" placeholder="e.g. A3"></label>' +
            '<label class="meta-field wide"><span>Tags (comma-separated)</span><input type="text" id="mf-tags-' + id + '" value="' + escHtml(tagsStr) + '" placeholder="peak, closer, floor filler"></label>' +
            '<label class="meta-field wide"><span>Notes</span><textarea id="mf-notes-' + id + '" rows="2">' + escHtml(meta.notes || '') + '</textarea></label>' +
            '<label class="meta-field checkbox"><input type="checkbox" id="mf-verified-' + id + '"' + (meta.verified ? ' checked' : '') + '> <span>YouTube link verified</span></label>' +
            '</div>' +
            '<div class="meta-actions">' +
            '<button class="btn" onclick="toggleTrackMetaEditor(\'' + id + '\')">Cancel</button>' +
            '<button class="btn btn-primary" onclick="saveTrackMetaFromForm(\'' + id + '\',' + releaseId + ',\'' + youtubeId + '\')">Save</button>' +
            '</div>';
    });
}

function saveTrackMetaFromForm(metaId, releaseId, youtubeId) {
    var bpmRaw = document.getElementById('mf-bpm-' + metaId).value.trim();
    var bpm = bpmRaw === '' ? null : parseFloat(bpmRaw);
    var energyRaw = document.getElementById('mf-energy-' + metaId).value.trim();
    var energy = energyRaw === '' ? null : parseInt(energyRaw, 10);
    var rating = parseInt(document.getElementById('mf-rating-' + metaId).value, 10);
    var tagsRaw = document.getElementById('mf-tags-' + metaId).value.trim();
    var patch = {
        release_id: releaseId,
        youtube_id: youtubeId,
        bpm: (bpm != null && isFinite(bpm)) ? bpm : null,
        key: document.getElementById('mf-key-' + metaId).value || null,
        rating: rating > 0 ? rating : null,
        energy: (energy != null && isFinite(energy)) ? energy : null,
        shelf: document.getElementById('mf-shelf-' + metaId).value.trim() || '',
        tags: tagsRaw ? tagsRaw.split(',').map(function (t) { return t.trim(); }).filter(function (t) { return !!t; }) : [],
        notes: document.getElementById('mf-notes-' + metaId).value.trim() || '',
        verified: document.getElementById('mf-verified-' + metaId).checked
    };
    saveTrackMeta(metaId, patch).then(function () {
        renderCurrentView();
    });
}

// ============ Utility ============

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Escape a value for use inside a single-quoted JS string in an inline handler.
function escJs(str) {
    if (!str) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ============ Harmonic Suggestions ============

var _suggestions = [];

function parseCamelot(k) {
    if (!k) return null;
    var m = /^(\d{1,2})([AB])$/i.exec(String(k).trim());
    if (!m) return null;
    var n = parseInt(m[1], 10);
    if (n < 1 || n > 12) return null;
    return { n: n, letter: m[2].toUpperCase() };
}

function compatibleKeys(k) {
    var p = parseCamelot(k);
    if (!p) return [];
    var next = (p.n % 12) + 1;
    var prev = ((p.n - 2 + 12) % 12) + 1;
    return [
        p.n + p.letter,                                    // same key
        next + p.letter,                                   // +1 on wheel
        prev + p.letter,                                   // -1 on wheel
        p.n + (p.letter === 'A' ? 'B' : 'A')               // relative major/minor
    ];
}

function bpmDelta(a, b) {
    if (!a || !b) return Infinity;
    var d1 = Math.abs(a - b) / Math.min(a, b) * 100;
    var d2 = Math.abs(a * 2 - b) / Math.min(a * 2, b) * 100;
    var d3 = Math.abs(a - b * 2) / Math.min(a, b * 2) * 100;
    return Math.min(d1, d2, d3);
}

function scoreCandidate(current, cand) {
    var score = 0;
    var keyMatched = false;
    if (current.key && cand.key) {
        var compat = compatibleKeys(current.key);
        var idx = compat.indexOf(cand.key);
        if (idx === 0) { score += 100; keyMatched = true; }
        else if (idx > 0) { score += 70; keyMatched = true; }
    }
    if (!keyMatched && current.genres && cand.genres) {
        var curGenres = current.genres.split(', ');
        var hit = curGenres.some(function (g) { return g && cand.genres.indexOf(g) !== -1; });
        if (hit) score += 40;
    }
    if (current.bpm && cand.bpm) {
        var delta = bpmDelta(current.bpm, cand.bpm);
        if (delta <= 6) score += Math.max(0, 100 - delta * 10);
        else if (delta <= 12) score += Math.max(0, 50 - (delta - 6) * 3);
    }
    if (cand.rating) score += cand.rating * 2;
    return score;
}

function openSuggestions() {
    var existing = document.getElementById('suggestions-panel');
    if (existing) { closeSuggestions(); return; }
    if (currentIndex < 0 || !currentQueue[currentIndex]) return;

    var cur = currentQueue[currentIndex];
    Promise.all([
        dbGetAll('videos'),
        dbGetAll('releases'),
        dbGetAll('track_meta')
    ]).then(function (results) {
        var videos = results[0];
        var releases = results[1];
        var metas = results[2];

        var curVid = null;
        for (var i = 0; i < videos.length; i++) {
            if (videos[i].youtube_id === cur.youtubeId &&
                    (!cur.releaseId || videos[i].release_id == cur.releaseId)) {
                curVid = videos[i]; break;
            }
        }
        var relById = {};
        releases.forEach(function (r) { relById[r.id] = r; });
        var metaById = {};
        metas.forEach(function (m) { metaById[m.id] = m; });

        var curRel = curVid ? (relById[curVid.release_id] || null) : null;
        var curMeta = curVid ? (metaById[curVid.release_id + '_' + curVid.youtube_id] || null) : null;
        var ctx = {
            bpm: curMeta ? curMeta.bpm : null,
            key: curMeta ? curMeta.key : null,
            genres: curRel ? curRel.genres : null
        };

        var queueSet = {};
        currentQueue.forEach(function (t) { queueSet[(t.releaseId || '') + '_' + t.youtubeId] = true; });

        var cands = [];
        videos.forEach(function (v) {
            if (!v.youtube_id || queueSet[(v.release_id || '') + '_' + v.youtube_id]) return;
            var r = relById[v.release_id] || {};
            var m = metaById[v.release_id + '_' + v.youtube_id] || {};
            var c = {
                youtubeId: v.youtube_id,
                title: v.title,
                artist: r.artist || '',
                cover: r.thumb_url || '',
                releaseId: v.release_id,
                releaseTitle: r.title || '',
                bpm: m.bpm != null ? m.bpm : null,
                key: m.key || null,
                rating: m.rating || null,
                genres: r.genres || ''
            };
            c.score = scoreCandidate(ctx, c);
            if (c.score > 0) cands.push(c);
        });
        cands.sort(function (a, b) { return b.score - a.score; });
        _suggestions = cands.slice(0, 20);
        renderSuggestionsPanel(ctx, _suggestions);
    });
}

function renderSuggestionsPanel(ctx, cands) {
    var panel = document.createElement('div');
    panel.id = 'suggestions-panel';
    panel.className = 'suggestions-panel';

    var metaBits = [];
    if (ctx.bpm) metaBits.push(ctx.bpm + ' BPM');
    if (ctx.key) metaBits.push('Key ' + ctx.key);
    if (!ctx.bpm && !ctx.key) metaBits.push('no BPM/key &mdash; matching by genre');

    var html = '<div class="suggestions-header">' +
        '<span class="suggestions-title">Next up &mdash; harmonic matches</span>' +
        '<button class="meta-btn" onclick="closeSuggestions()" title="Close">&times;</button>' +
        '</div>';
    html += '<div class="suggestions-sub">Current: ' + metaBits.join(' &middot; ') + '</div>';

    if (cands.length === 0) {
        html += '<div class="suggestions-empty">No matches. Tag more tracks with BPM/key in the metadata editor to get better suggestions.</div>';
    } else {
        html += '<div class="suggestions-list">';
        cands.forEach(function (c, i) {
            html += '<div class="suggestion-row">';
            if (c.cover) html += '<img class="track-thumb" src="' + escHtml(c.cover) + '" alt="" loading="lazy">';
            else html += '<div class="track-thumb no-thumb">&#9898;</div>';
            html += '<div class="track-info">' +
                '<div class="track-title-line">' + escHtml(c.title) + '</div>' +
                '<div class="track-sub-line">' + escHtml(c.artist) + (c.releaseTitle ? ' &middot; ' + escHtml(c.releaseTitle) : '') + '</div>' +
                '</div>';
            html += '<span class="track-badges">';
            if (c.bpm != null) html += '<span class="track-badge badge-bpm">' + c.bpm + '</span>';
            if (c.key) html += '<span class="track-badge badge-key">' + escHtml(c.key) + '</span>';
            if (c.rating) html += '<span class="track-badge badge-rating">' + ratingStars(c.rating) + '</span>';
            html += '<span class="track-badge score-badge">' + Math.round(c.score) + '</span>';
            html += '</span>';
            html += '<div class="suggestion-actions">' +
                '<button class="btn btn-primary" onclick="playNextSuggestion(' + i + ')">Play next</button>' +
                '<button class="btn" onclick="addSuggestionToQueue(' + i + ')">Queue</button>' +
                '</div>';
            html += '</div>';
        });
        html += '</div>';
    }
    panel.innerHTML = html;
    document.body.appendChild(panel);
    var btn = document.getElementById('np-suggest');
    if (btn) btn.classList.add('active');
}

function closeSuggestions() {
    var panel = document.getElementById('suggestions-panel');
    if (panel) panel.remove();
    var btn = document.getElementById('np-suggest');
    if (btn) btn.classList.remove('active');
}

function playNextSuggestion(idx) {
    var c = _suggestions[idx];
    if (!c) return;
    var item = { youtubeId: c.youtubeId, title: c.title, artist: c.artist, cover: c.cover };
    currentQueue.splice(currentIndex + 1, 0, item);
    currentIndex++;
    loadFromQueue(currentIndex);
    closeSuggestions();
}

function addSuggestionToQueue(idx) {
    var c = _suggestions[idx];
    if (!c) return;
    currentQueue.push({ youtubeId: c.youtubeId, releaseId: c.releaseId || null, title: c.title, artist: c.artist, cover: c.cover });
    _savePlayerState();
    if (document.getElementById('queue-panel')) _renderQueuePanel();
    showSyncBanner('Queued: ' + c.title);
    setTimeout(hideSyncBanner, 1200);
}

// ============ Queue Panel ============

function makeDraggable(panel) {
    var header = panel.querySelector('.queue-header');
    if (!header) return;
    var isDragging = false, ox = 0, oy = 0;
    header.style.cursor = 'move';
    header.addEventListener('mousedown', function (e) {
        if (e.target.closest('button')) return;
        isDragging = true;
        var rect = panel.getBoundingClientRect();
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        ox = e.clientX - rect.left;
        oy = e.clientY - rect.top;
        e.preventDefault();
    });
    function onMove(e) {
        if (!isDragging) return;
        var l = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - ox));
        var t = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
        panel.style.left = l + 'px';
        panel.style.top = t + 'px';
    }
    function onUp() { isDragging = false; }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    panel._cleanup = function () {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };
}

function openQueue() {
    var existing = document.getElementById('queue-panel');
    if (existing) { closeQueue(); return; }
    if (currentQueue.length === 0) return;
    _renderQueuePanel();
}

function closeQueue() {
    var panel = document.getElementById('queue-panel');
    if (panel) {
        if (panel._cleanup) panel._cleanup();
        panel.remove();
    }
    var btn = document.getElementById('np-queue');
    if (btn) btn.classList.remove('active');
}

function _renderQueuePanel() {
    var existing = document.getElementById('queue-panel');
    if (existing) existing.remove();

    var panel = document.createElement('div');
    panel.id = 'queue-panel';
    panel.className = 'queue-panel';

    var html = '<div class="queue-header">' +
        '<span class="queue-title">&#9776; Queue &mdash; ' + currentQueue.length + ' track' + (currentQueue.length === 1 ? '' : 's') + '</span>' +
        '<div class="queue-header-actions">' +
        '<button class="btn" onclick="saveQueueAsSetlist()">Save as setlist</button>' +
        '<button class="meta-btn" onclick="closeQueue()" title="Close">&times;</button>' +
        '</div></div>';

    html += '<div class="queue-list">';
    currentQueue.forEach(function (item, i) {
        var isCurrent = (i === currentIndex);
        html += '<div class="queue-row' + (isCurrent ? ' queue-current' : '') + '">';
        html += '<span class="queue-num">' + (i + 1) + '</span>';
        if (item.cover) {
            html += '<img class="track-thumb" src="' + escHtml(item.cover) + '" alt="" loading="lazy">';
        } else {
            html += '<div class="track-thumb no-thumb">&#9898;</div>';
        }
        html += '<div class="track-info">' +
            '<div class="track-title-line">' + escHtml(item.title) + '</div>' +
            '<div class="track-sub-line">' + escHtml(item.artist) + '</div>' +
            '</div>';
        html += '<div class="queue-actions">' +
            '<button class="btn queue-play-btn" onclick="playFromQueuePanel(' + i + ')" title="Play from here">&#9654;</button>' +
            '<button class="btn queue-remove-btn" onclick="removeFromQueuePanel(' + i + ')" title="Remove">&times;</button>' +
            '</div>';
        html += '</div>';
    });
    html += '</div>';

    panel.innerHTML = html;
    document.body.appendChild(panel);
    makeDraggable(panel);

    var npBtn = document.getElementById('np-queue');
    if (npBtn) npBtn.classList.add('active');

    // Scroll current track into view
    setTimeout(function () {
        var cur = panel.querySelector('.queue-current');
        if (cur) cur.scrollIntoView({ block: 'nearest' });
    }, 50);
}

function playFromQueuePanel(idx) {
    if (idx < 0 || idx >= currentQueue.length) return;
    currentIndex = idx;
    loadFromQueue(currentIndex);
    _renderQueuePanel();
}

function removeFromQueuePanel(idx) {
    if (idx < 0 || idx >= currentQueue.length) return;
    currentQueue.splice(idx, 1);
    if (currentIndex > idx) currentIndex--;
    else if (currentIndex === idx && currentIndex >= currentQueue.length) currentIndex = Math.max(0, currentQueue.length - 1);
    _savePlayerState();
    if (cfEnabled && _cfState === 'preloaded') {
        _abortCrossfade();
        setTimeout(_preloadNextTrack, 200);
    }
    if (currentQueue.length === 0) { closeQueue(); return; }
    _renderQueuePanel();
}

function saveQueueAsSetlist() {
    if (currentQueue.length === 0) return;
    var name = prompt('Name for new setlist:');
    if (!name || !name.trim()) return;
    var now = new Date().toISOString();
    var tracks = currentQueue.map(function (item) {
        return {
            youtubeId: item.youtubeId,
            title: item.title,
            artist: item.artist || '',
            cover: item.cover || '',
            releaseId: item.releaseId || null,
            metaId: item.metaId || null
        };
    });
    openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('setlists', 'readwrite');
            var req = tx.objectStore('setlists').add({
                name: name.trim(),
                created_at: now,
                updated_at: now,
                tracks: tracks,
                notes: ''
            });
            req.onsuccess = function () { resolve(); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    }).then(function () {
        closeQueue();
        showSyncBanner('Saved \u201c' + name.trim() + '\u201d \u2014 ' + tracks.length + ' track' + (tracks.length === 1 ? '' : 's'));
        setTimeout(hideSyncBanner, 2000);
    });
}

// ============ Init ============

document.addEventListener('DOMContentLoaded', function () {
    _saveInterval = setInterval(function () { if (isPlaying) _savePlayerState(); }, 2000);

    document.getElementById('np-close').addEventListener('click', hideNowPlaying);
    document.getElementById('np-play-pause').addEventListener('click', function () {
        if (!player || !playerReady) return;
        if (isPlaying) player.pauseVideo(); else player.playVideo();
    });
    document.getElementById('np-next').addEventListener('click', function () {
        if (currentIndex < currentQueue.length - 1) { currentIndex++; loadFromQueue(currentIndex); if (document.getElementById('queue-panel')) _renderQueuePanel(); }
    });
    document.getElementById('np-prev').addEventListener('click', function () {
        if (currentIndex > 0) { currentIndex--; loadFromQueue(currentIndex); if (document.getElementById('queue-panel')) _renderQueuePanel(); }
    });
    document.getElementById('np-suggest').addEventListener('click', openSuggestions);
    document.getElementById('np-queue').addEventListener('click', openQueue);
    document.getElementById('np-add-setlist').addEventListener('click', function () {
        openNowPlayingAddToSetlist(this);
    });
    document.getElementById('np-goto-release').addEventListener('click', gotoNowPlayingRelease);

    document.getElementById('np-cf-toggle').addEventListener('click', function () {
        cfEnabled = !cfEnabled;
        var secInput = document.getElementById('np-cf-seconds');
        var newSec = parseInt(secInput.value, 10);
        if (!isNaN(newSec) && newSec >= 1) cfSeconds = newSec;
        _updateCfUI();
        _saveCrossfadeSettings();
        if (cfEnabled) {
            _startCfCheckInterval();
            if (isPlaying) _preloadNextTrack();
        } else {
            _stopCfCheckInterval();
            if (_cfState !== 'idle') _abortCrossfade();
        }
    });

    document.getElementById('np-cf-seconds').addEventListener('change', function () {
        var v = parseInt(this.value, 10);
        if (isNaN(v) || v < 1) { this.value = cfSeconds; return; }
        if (v > 30) { this.value = 30; v = 30; }
        cfSeconds = v;
        _saveCrossfadeSettings();
    });

    _loadCrossfadeSettings();

    updateNotifBadge();
    startMarketplacePoll();

    window.addEventListener('popstate', function () {
        if (_navHistory.length === 0) return;
        var prev = _navHistory.pop();
        _navFromPop = true;
        _currentView = prev.view;
        _filters = prev.filters;
        renderCurrentView();
        window.scrollTo(0, 0);
        _navFromPop = false;
    });

    navigate('collection');
});
