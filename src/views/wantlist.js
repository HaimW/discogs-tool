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
