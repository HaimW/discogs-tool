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

