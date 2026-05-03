
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

