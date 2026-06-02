
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
        syncMarketplaceStats(false, config).then(function () {
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
    var unsynced = wants.filter(function (w) { return !w.synced_at || !w.country; });
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

    // Kick off marketplace availability check silently after full sync,
    // but only if collection sync isn't also running (shared rate-limit bucket).
    if (!_syncRunning) {
        syncMarketplaceStats(true, config).catch(function (err) {
            console.error('Marketplace stats sync failed:', err);
        });
    }
}
