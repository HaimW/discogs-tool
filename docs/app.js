/* ================================================
   Vinyl Collection Player v2 — Pure client-side SPA
   IndexedDB storage, Discogs API, YouTube player
   ================================================ */

// ============ IndexedDB Storage ============

var DB_NAME = 'VinylCollectionPlayer';
var DB_VERSION = 2;
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

function discogsGet(path, config) {
    var headers = {
        'Authorization': 'Discogs token=' + config.token,
        'User-Agent': 'VinylCollectionPlayer/2.0'
    };
    return fetch('https://api.discogs.com' + path, { headers: headers })
        .then(function (r) {
            if (!r.ok) throw new Error('Discogs API error: ' + r.status);
            return r.json();
        });
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
        syncCollection(config).then(function () {
            showSyncBanner('Sync complete!');
            setTimeout(function () { hideSyncBanner(); navigate('collection'); }, 1500);
        }).catch(function (err) {
            showSyncBanner('Sync failed: ' + err.message);
            console.error(err);
        }).finally(function () {
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

    if (realFolders.length === 0) {
        await fetchFolderReleases(config, 0, allReleases, null);
    } else {
        for (var fi = 0; fi < realFolders.length; fi++) {
            showSyncBanner('Fetching folder: ' + realFolders[fi].name + '...');
            await fetchFolderReleases(config, realFolders[fi].id, allReleases, realFolders[fi].id);
        }
    }

    // Save releases to IndexedDB
    var ids = Object.keys(allReleases);
    showSyncBanner('Saving ' + ids.length + ' releases...');
    for (var ri = 0; ri < ids.length; ri++) {
        await dbPut('releases', allReleases[ids[ri]]);
    }

    // Phase 2: Fetch videos
    var releases = await dbGetAll('releases');
    var unsynced = releases.filter(function (r) { return !r.synced_at; });
    var total = unsynced.length;

    for (var vi = 0; vi < unsynced.length; vi++) {
        var rel = unsynced[vi];
        showSyncBanner('Fetching videos: ' + (vi + 1) + '/' + total + ' - ' + rel.artist + ' - ' + rel.title);

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
        await sleep(1000);
    }
}

async function fetchFolderReleases(config, folderId, allReleases, tagFolderId) {
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
            } else {
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
            return url.searchParams.get('v');
        }
        if (url.hostname.indexOf('youtu.be') !== -1) {
            return url.pathname.slice(1);
        }
    } catch (e) {}
    return null;
}

// ============ SPA Router ============

var _currentView = '';
var _filters = { q: '', genre: '', folder: '', sort: 'artist', page: 1 };

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
    Promise.all([dbGetAll('releases'), dbGetAll('folders')]).then(function (results) {
        var allReleases = results[0];
        var folders = results[1].filter(function (f) { return f.id !== 0; });

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
                '<button class="btn btn-shuffle" onclick="shufflePlay()">&#9840; Shuffle Play</button>' +
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
                html += '<span class="genre-pill' + (_filters.genre === g ? ' active' : '') + '" onclick="setFilter(\'genre\',\'' + escHtml(g) + '\')">' + escHtml(g) + '</span>';
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

// ============ Release Detail View ============

function renderRelease(releaseId) {
    Promise.all([
        dbGet('releases', releaseId),
        dbGetByIndex('videos', 'release_id', releaseId)
    ]).then(function (results) {
        var r = results[0];
        var videos = results[1].sort(function (a, b) { return (a.position || 0) - (b.position || 0); });

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
                html += '<div class="video-item" data-youtube-id="' + escHtml(vid.youtube_id) + '" data-title="' + escHtml(vid.title) + '" data-artist="' + escHtml(r.artist) + '" data-cover="' + escHtml(r.thumb_url || '') + '">' +
                    '<button class="play-btn" onclick="playTrack(this.parentElement)"><span class="play-icon">&#9654;</span></button>' +
                    '<div class="video-info"><span class="video-title">' + escHtml(vid.title) + '</span>';
                if (vid.duration) {
                    html += '<span class="video-duration">' + escHtml(String(vid.duration)) + '</span>';
                }
                html += '</div></div>';
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
            updatePlayPauseBtn();
        }
    } else if (event.data === YT.PlayerState.PLAYING) {
        isPlaying = true;
        updatePlayPauseBtn();
        _savePlayerState();
    } else if (event.data === YT.PlayerState.PAUSED) {
        isPlaying = false;
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
    document.getElementById('now-playing').style.display = 'none';
    document.body.style.paddingBottom = '0';
    if (player && playerReady) player.stopVideo();
    isPlaying = false;
    currentQueue = [];
    currentIndex = -1;
    sessionStorage.removeItem('playerState');
    highlightActiveTrack();
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

function shufflePlay() {
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

            // Take first 50
            var selected = matchingVideos.slice(0, 50);
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
        });
    });
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

// ============ Utility ============

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

    navigate('collection');
});
