/* ================================================
   Vinyl Collection Player v2 — Pure client-side SPA
   IndexedDB storage, Discogs API, YouTube player
   ================================================ */

// ============ IndexedDB Storage ============

var DB_NAME = 'VinylCollectionPlayer';
var DB_VERSION = 4;
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
                    folder_ids: []
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
    q: '', genre: '', folder: '', sort: 'artist', page: 1,
    tracks: { q: '', bpmMin: '', bpmMax: '', key: '', minRating: 0, tag: '', sort: 'artist', page: 1 },
    setlistId: null
};

function navigate(view, params) {
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

        // Build HTML
        var html = '';

        // Header
        html += '<div class="collection-header"><div class="collection-stats">' +
                '<h1>Your Collection</h1>' +
                '<span class="stat-count">' + filtered.length + ' releases</span>' +
                '<div class="shuffle-controls">' +
                '<input type="number" id="shuffle-count" class="shuffle-count-input" value="50" min="1" max="9999" title="Number of tracks to shuffle">' +
                '<button class="btn btn-shuffle" onclick="shufflePlay()">&#9840; Shuffle Play</button>' +
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
            if (_filters.q || _filters.genre || _filters.folder) {
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
        dbGetByIndex('track_meta', 'release_id', releaseId)
    ]).then(function (results) {
        var r = results[0];
        var videos = results[1].sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
        var metaById = {};
        (results[2] || []).forEach(function (m) { metaById[m.id] = m; });

        if (!r) { navigate('collection'); return; }

        var html = '<span class="back-link" onclick="navigate(\'collection\')">&larr; Back to collection</span>';
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
    });
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
}

function onPlayerStateChange(event) {
    if (event.data === YT.PlayerState.ENDED) {
        if (currentIndex < currentQueue.length - 1) {
            currentIndex++;
            loadFromQueue(currentIndex);
        } else {
            isPlaying = false;
            stopViz();
            updatePlayPauseBtn();
        }
    } else if (event.data === YT.PlayerState.PLAYING) {
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
    player.loadVideoById(item.youtubeId);
    showNowPlaying(item.title, item.artist, item.cover);
    isPlaying = true;
    updatePlayPauseBtn();
    _savePlayerState();
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

    if (vizType === 'bars')      { _drawBars(w, h, vizBeat); }
    else if (vizType === 'wave') { _drawWave(w, h, vizBeat); }
    else if (vizType === 'particles') { _drawParticles(w, h, vizBeat); }
    else if (vizType === 'rings') { _drawRings(w, h, vizBeat); }

    vizAnimFrame = requestAnimationFrame(_vizLoop);
}

// VIZ 1 — Neon Spectrum Bars
function _drawBars(w, h, beat) {
    var ctx = vizCtx;
    // Fade trail
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, w, h);

    var numBars = 36;
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

function openQueue() {
    var existing = document.getElementById('queue-panel');
    if (existing) { closeQueue(); return; }
    if (currentQueue.length === 0) return;
    _renderQueuePanel();
}

function closeQueue() {
    var panel = document.getElementById('queue-panel');
    if (panel) panel.remove();
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
        if (currentIndex < currentQueue.length - 1) { currentIndex++; loadFromQueue(currentIndex); }
    });
    document.getElementById('np-prev').addEventListener('click', function () {
        if (currentIndex > 0) { currentIndex--; loadFromQueue(currentIndex); }
    });
    document.getElementById('np-suggest').addEventListener('click', openSuggestions);
    document.getElementById('np-queue').addEventListener('click', openQueue);
    document.getElementById('np-add-setlist').addEventListener('click', function () {
        openNowPlayingAddToSetlist(this);
    });
    document.getElementById('np-goto-release').addEventListener('click', gotoNowPlayingRelease);

    navigate('collection');
});
