
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
            html += vinylTracklistHtml(tracklistTracks, function (t) {
                return metaForTrack(t, videos, metaById, r.id);
            });
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
                    html += bpmBadge(meta);
                    if (meta.key) html += camelotChip(meta.key, { estimated: meta.key_source === 'analysis' && !meta.bpm_verified });
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

// Words that carry no identity, thrown away before matching. Kept in step with
// the analyzer's own list in desktop-analyzer/crates/core/src/plan.rs — the two
// sides answer the same question ("is this video this track?") and disagreeing
// about it would show up as a badge appearing here but not there.
var TITLE_NOISE = ['official', 'video', 'audio', 'hd', 'hq', '4k', 'remastered',
    'remaster', 'lyrics', 'lyric', 'full', 'the', 'a', 'vinyl'];

// Share of a tracklist title's words that must survive in the video title.
var TITLE_MATCH_THRESHOLD = 0.6;

function titleTokens(s) {
    return String(s == null ? '' : s).toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter(function (w) { return w && TITLE_NOISE.indexOf(w) === -1; });
}

// Find the metadata for a printed tracklist entry.
//
// The two are keyed differently and cannot be joined directly: the vinyl
// tracklist comes from Discogs and says "More Sugar", while metadata is keyed
// by YouTube id on a video called "Physical Therapy - More Sugar (Official
// Video)". So we ask how much of the *tracklist* title survives in the video
// title, which is the same test the analyzer applies when it decides whether a
// linked video really is the track it claims to be.
//
// Returns null when nothing matches well enough. A wrong badge here is worse
// than no badge: it would put one track's tempo against another's name.
//
// The video list can hold several links for one track — duplicate uploads, or
// genuinely different mixes — while the printed tracklist is the fixed, correct
// one. So this resolves in two stages. The best-matching title wins outright,
// which is what keeps "String Thing (Desensitized Mix)" off the video called
// "String Thing (Sensitized Mix)": those are different records and a near miss
// must not lend its tempo. Only among videos matching *equally well* — the
// duplicate-upload case, where either would be the same audio — does it prefer
// the one that actually carries data, and a confirmed value over an estimate.
function metaForTrack(track, videos, metaById, releaseId) {
    var wanted = titleTokens(track.title);
    if (!wanted.length) return null;

    var best = [];
    var bestScore = 0;
    videos.forEach(function (vid) {
        var have = titleTokens(vid.title);
        if (!have.length) return;
        var hits = wanted.filter(function (w) { return have.indexOf(w) !== -1; }).length;
        var score = hits / wanted.length;
        if (score < TITLE_MATCH_THRESHOLD) return;
        if (score > bestScore) { bestScore = score; best = []; }
        if (score === bestScore) best.push(metaById[releaseId + '_' + vid.youtube_id] || null);
    });

    var ranked = best.filter(Boolean).sort(function (a, b) {
        return rank(b) - rank(a);
    });
    return ranked.length ? ranked[0] : null;
}

// How much a record is worth showing when several say the same thing: a value
// someone confirmed beats an estimate, and an estimate beats an empty record.
function rank(meta) {
    if (meta.bpm_verified) return 3;
    if (meta.bpm != null || meta.key) return 2;
    return 1;
}

// The tempo badge, marked as an estimate unless a human has confirmed it.
//
// Kept separate from the key chip because the two answer different questions:
// `camelotChip` also carries the Camelot colour, while this is just a number
// that must not look more certain than it is. After an analyzer run nearly
// every value is an estimate, so an unmarked figure would be actively
// misleading.
function bpmBadge(meta) {
    if (meta.bpm == null || meta.bpm === '') return '';
    var estimated = meta.bpm_source === 'analysis' && !meta.bpm_verified;
    var title = estimated
        ? 'Estimated by analysis' +
          (meta.bpm_confidence != null ? ' — confidence ' + pct(meta.bpm_confidence) : '')
        : 'BPM';
    return '<span class="track-badge badge-bpm' + (estimated ? ' badge-estimated' : '') +
        '" title="' + escHtml(title) + '">' +
        escHtml(String(meta.bpm)) + ' BPM' +
        (estimated ? '<span class="badge-est">~</span>' : '') +
        '</span>';
}

function vinylTracklistHtml(tracks, lookup) {
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
            var meta = lookup ? lookup(t) : null;
            var badges = !meta ? '' : (bpmBadge(meta) + (meta.key
                ? camelotChip(meta.key, { estimated: meta.key_source === 'analysis' && !meta.bpm_verified })
                : ''));
            html += '<div class="vt-track">' +
                '<span class="vt-pos">' + escHtml(t.position || '') + '</span>' +
                '<span class="vt-title">' + escHtml(t.title || '') + '</span>' +
                '<span class="vt-dur">' + escHtml(t.duration || '') + '</span>' +
                // Only emitted when there is something to show, so a release
                // with no analysis keeps the compact single-line rows it has now.
                (badges ? '<span class="track-badges">' + badges + '</span>' : '') +
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
        // Re-read videos and metadata rather than closing over the caller's:
        // this runs after an await, and a track analysed in the meantime should
        // show its badge as soon as the panel is rebuilt.
        var lazyVideos = await dbGetByIndex('videos', 'release_id', releaseId);
        var lazyMetaById = {};
        (await dbGetByIndex('track_meta', 'release_id', releaseId) || []).forEach(function (m) {
            lazyMetaById[m.id] = m;
        });
        if (panelEl) {
            panelEl.innerHTML = vinylTracklistHtml(displayTracks, function (t) {
                return metaForTrack(t, lazyVideos || [], lazyMetaById, releaseId);
            });
        }
    } catch (err) {
        console.error('Tracklist fetch failed:', err);
    }
}

