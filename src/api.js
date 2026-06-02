// ============ Discogs API ============

// ---------------------------------------------------------------------------
// Adaptive rate limiter
//
// Discogs uses a 60-second sliding-window token bucket:
//   authenticated  → 60 req / 60 s
//   unauthenticated → 25 req / 60 s
//
// After every successful response we read the X-Discogs-Ratelimit-* headers
// and store them in _rl.  Before every request we call _rlDelay() which
// returns the minimum safe wait time based on current headroom.
//
// The formula accounts for token replenishment: if `elapsed` milliseconds
// have passed since the last header read, roughly (elapsed/60000)*limit
// tokens have refilled.  We then spread the effective remaining quota evenly
// over the rest of the window:
//
//   effective = min(remaining + (elapsed/60000)*limit, limit)
//   delay     = max(MIN_MS, round(60000 / effective))
//
// Examples (auth bucket, limit=60, no elapsed time):
//   remaining=60 → delay=1000ms   remaining=20 → delay=3000ms
//   remaining=10 → delay=6000ms   remaining= 2 → delay=15000ms (hard cap)
// ---------------------------------------------------------------------------

var _rl = {
    auth:   { limit: 60, remaining: null, updatedAt: 0 },
    public: { limit: 25, remaining: null, updatedAt: 0 }
};

function _rlUpdate(bucket, headers) {
    var limit     = parseInt(headers.get('X-Discogs-Ratelimit'), 10);
    var remaining = parseInt(headers.get('X-Discogs-Ratelimit-Remaining'), 10);
    if (Number.isFinite(remaining)) {
        if (Number.isFinite(limit)) bucket.limit = limit;
        bucket.remaining = remaining;
        bucket.updatedAt = Date.now();
        console.debug('[rl] remaining=' + remaining + '/' + bucket.limit);
    }
}

function _rlDelay(bucket) {
    if (bucket.remaining === null) return 1000;  // no data yet — safe default
    if (bucket.remaining <= 1)    return 15000;  // nearly exhausted

    var elapsed   = Math.min(Date.now() - bucket.updatedAt, 60000);
    var effective = Math.min(bucket.remaining + (elapsed / 60000) * bucket.limit, bucket.limit);
    return Math.max(200, Math.round(60000 / effective));
}

async function discogsGet(path, config, _retries) {
    if (_retries === undefined) _retries = 3;

    await sleep(_rlDelay(_rl.auth));

    var headers = { 'Authorization': 'Discogs token=' + config.token };
    var r;
    try {
        r = await fetch('https://api.discogs.com' + path, { headers: headers });
    } catch (err) {
        // Network error or CORS block (a 429 without CORS headers lands here)
        if (_retries <= 0) throw err;
        var backoff = [5, 15, 30][3 - _retries] || 5;
        console.warn('Request failed on ' + path + ', backing off ' + backoff + 's (retries left: ' + (_retries - 1) + ')');
        showSyncBanner('Network error — retrying in ' + backoff + 's...');
        await sleep(backoff * 1000);
        return discogsGet(path, config, _retries - 1);
    }

    if (r.status === 429) {
        if (_retries <= 0) throw new Error('Rate limited after retries');
        var _retryAfter = parseInt(r.headers.get('Retry-After'), 10);
        var wait = (Number.isFinite(_retryAfter) && _retryAfter > 0 ? _retryAfter : 30) * 1000;
        // Mark bucket as exhausted so _rlDelay recovers gradually after the wait.
        _rl.auth.remaining = 0;
        _rl.auth.updatedAt = Date.now();
        console.warn('429 on ' + path + ', waiting ' + (wait / 1000) + 's...');
        showSyncBanner('Rate limited — waiting ' + (wait / 1000) + 's...');
        await sleep(wait);
        return discogsGet(path, config, _retries - 1);
    }

    if (!r.ok) throw new Error('Discogs API ' + r.status + ' on ' + path);

    _rlUpdate(_rl.auth, r.headers);
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

// Public Discogs endpoints (e.g. /marketplace/stats) do not need authentication.
// Sending an Authorization header forces a CORS preflight (OPTIONS) which Discogs
// does not support for these endpoints, causing the browser to block the request.
// This function makes a plain GET with no custom headers so the browser treats it
// as a simple CORS request (no preflight required).
async function discogsGetPublic(path, _retries) {
    if (_retries === undefined) _retries = 3;

    await sleep(_rlDelay(_rl.public));

    var r;
    try {
        r = await fetch('https://api.discogs.com' + path);
    } catch (err) {
        if (_retries <= 0) throw err;
        var backoff = [5, 15, 30][3 - _retries] || 5;
        console.warn('Request failed on ' + path + ', backing off ' + backoff + 's (retries left: ' + (_retries - 1) + ')');
        showSyncBanner('Network error — retrying in ' + backoff + 's...');
        await sleep(backoff * 1000);
        return discogsGetPublic(path, _retries - 1);
    }

    if (r.status === 429) {
        if (_retries <= 0) throw new Error('Rate limited after retries');
        var _retryAfter = parseInt(r.headers.get('Retry-After'), 10);
        var wait = (Number.isFinite(_retryAfter) && _retryAfter > 0 ? _retryAfter : 60) * 1000;
        _rl.public.remaining = 0;
        _rl.public.updatedAt = Date.now();
        console.warn('429 on ' + path + ', waiting ' + (wait / 1000) + 's...');
        showSyncBanner('Rate limited — waiting ' + (wait / 1000) + 's...');
        await sleep(wait);
        return discogsGetPublic(path, _retries - 1);
    }

    if (!r.ok) throw new Error('Discogs API ' + r.status + ' on ' + path);
    _rlUpdate(_rl.public, r.headers);
    return r.json();
}

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
            newRel.country = existing.country || null;
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
    var unsynced = releases.filter(function (r) { return !r.synced_at || !r.country; });
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
