var _marketplacePollInterval = null;
var _marketplaceSyncRunning = false;

async function syncMarketplaceStats(config, silent) {
    if (_marketplaceSyncRunning) return;
    _marketplaceSyncRunning = true;
    try {
        var wants = await dbGetAll('wants');
        if (wants.length === 0) return;

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

                // Notify only when previously confirmed as 0 and now has listings.
                // prevNum === null means never checked — record baseline silently.
                if (numForSale > 0 && prevNum !== null && prevNum === 0) {
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

        if (_currentView === 'wantlist') renderWantList();
        if (!silent) {
            showSyncBanner('Availability check complete!');
            setTimeout(hideSyncBanner, 2000);
        }
    } finally {
        _marketplaceSyncRunning = false;
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

