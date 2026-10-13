
function renderRelease(releaseId) {
    // IndexedDB keys are numbers; queues saved in sessionStorage by older
    // builds carry string ids, which would miss every lookup below.
    releaseId = parseInt(releaseId, 10) || releaseId;
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

        // Videos: one row per tracklist entry when the links can be matched to
        // it, the rest folded away; otherwise every link, as Discogs lists them.
        var match = matchVideos(tracklistTracks, videos, r.video_overrides, {
            rank: rankByMeta(metaById, r.id)
        });
        html += '<div class="release-tracklist-col">';
        if (tracklistTracks.length > 0) {
            html += vinylTracklistHtml(tracklistTracks, function (t) {
                return metaForMatchedTrack(t, match, metaById, r.id) ||
                    (match.grouped ? null : metaForTrack(t, videos, metaById, r.id));
            });
        } else {
            html += '<div id="vt-panel-' + r.id + '"></div>';
        }
        html += '</div></div>';

        var canOverride = !r._fromWantlist && match.grouped;
        var rowCtx = { r: r, metaById: metaById, tracks: canOverride ? tracklistTracks : null };

        html += '<div class="video-section"><div class="video-header"><h3>Tracklist</h3>';
        if (videos.length > 0) {
            html += '<div class="video-header-actions">';
            if (canOverride && r.video_overrides && Object.keys(r.video_overrides).length) {
                html += '<button class="btn btn-sm" onclick="resetVideoOverrides(' + r.id + ')" title="Forget your picks and match automatically">Reset picks</button>';
            }
            html += '<button class="btn btn-play-all" onclick="playAllFromRelease(' + r.id + ')">&#9654; Play All</button>';
            html += '</div>';
        }
        html += '</div>';

        if (videos.length > 0 && match.grouped) {
            html += '<div class="video-list">';
            match.rows.forEach(function (row) {
                var t = row.track;
                if (!row.winner) {
                    html += '<div class="vm-missing"><span class="vm-pos">' + escHtml(t.position || '') + '</span>' +
                        '<span class="vm-missing-title">' + escHtml(t.title || '') + '</span>' +
                        '<span class="vm-missing-note">no matching video</span></div>';
                    return;
                }
                html += videoRowHtml(row.winner, rowCtx, { pos: t.position, dupes: row.dupes.length, trackIndex: t.index });
                if (row.dupes.length) {
                    html += '<div class="vm-dupes" id="vm-dupes-' + r.id + '-' + t.index + '" style="display:none;">';
                    row.dupes.forEach(function (v) {
                        html += videoRowHtml(v, rowCtx, { cls: 'alt-upload' });
                    });
                    html += '</div>';
                }
            });
            html += '</div>';

            if (match.others.length) {
                html += '<div class="vm-others">' +
                    '<button class="vm-others-toggle" onclick="toggleVmGroup(this, \'vm-others-' + r.id + '\')" aria-expanded="false">' +
                    '<span class="vm-caret">&#9656;</span> Other videos (' + match.others.length + ')' +
                    '<span class="vm-others-hint">other mixes, DJ sets, clips &mdash; not on this pressing</span></button>' +
                    '<div class="video-list vm-others-list" id="vm-others-' + r.id + '" data-queue-scope style="display:none;">';
                match.others.forEach(function (v) {
                    html += videoRowHtml(v, rowCtx, { cls: 'vm-other' });
                });
                html += '</div></div>';
            }
        } else if (videos.length > 0) {
            html += '<div class="video-list">';
            videos.forEach(function (vid) {
                html += videoRowHtml(vid, rowCtx, {});
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

// One playable video row on the release page.
//   ctx  { r, metaById, tracks } — tracks is set when the user may re-pick
//   opts { pos, dupes, trackIndex, cls }
function videoRowHtml(vid, ctx, opts) {
    var r = ctx.r;
    var metaId = r.id + '_' + vid.youtube_id;
    var meta = ctx.metaById[metaId] || null;
    var html = '<div class="video-item' + (opts.cls ? ' ' + opts.cls : '') + '" data-youtube-id="' + escHtml(vid.youtube_id) + '" data-title="' + escHtml(vid.title) + '" data-artist="' + escHtml(r.artist) + '" data-cover="' + escHtml(r.thumb_url || '') + '" data-release-id="' + r.id + '" data-meta-id="' + escHtml(metaId) + '">' +
        '<button class="play-btn" onclick="playTrack(this.parentElement)"><span class="play-icon">&#9654;</span></button>' +
        '<div class="video-info">';
    if (opts.pos) html += '<span class="vm-pos">' + escHtml(opts.pos) + '</span>';
    html += '<span class="video-title">' + escHtml(vid.title) + '</span>';
    if (meta) {
        html += '<span class="track-badges">';
        html += bpmBadge(meta);
        if (meta.key) {
            html += camelotChip(meta.key, {
                estimated: meta.key_source === 'analysis' && !meta.bpm_verified,
                // Prefer the name the record actually stores over the
                // one the table would derive: if an older record
                // disagrees, show what is there rather than hiding it.
                musical: meta.key_musical || true
            });
        }
        html += energyBadge(meta);
        if (meta.rating) html += '<span class="track-badge badge-rating">' + ratingStars(meta.rating) + '</span>';
        if (meta.shelf) html += '<span class="track-badge badge-shelf">' + escHtml(meta.shelf) + '</span>';
        html += '</span>';
    }
    if (vid.duration) {
        html += '<span class="video-duration">' + escHtml(_fmtTime(Number(vid.duration))) + '</span>';
    }
    html += '</div>';
    if (opts.dupes) {
        html += '<button class="meta-btn vm-dupes-btn" onclick="toggleVmGroup(this, \'vm-dupes-' + r.id + '-' + opts.trackIndex + '\')" aria-expanded="false" title="Other uploads of this track">+' + opts.dupes + '</button>';
    }
    if (ctx.tracks && opts.cls) {
        html += '<select class="vm-assign" title="Use this video for a track" aria-label="Use this video for a track" onchange="setVideoOverride(' + r.id + ', this.value, \'' + escJs(vid.youtube_id) + '\')">' +
            '<option value="">Use for&hellip;</option>';
        ctx.tracks.forEach(function (t) {
            html += '<option value="' + t.index + '">' + escHtml((t.position ? t.position + ' — ' : '') + t.title) + '</option>';
        });
        html += '</select>';
    }
    html += '<button class="meta-btn add-btn" onclick="openAddToSetlistPopover(this)" title="Add to setlist">+</button>' +
        '<button class="meta-btn" onclick="toggleTrackMetaEditor(\'' + metaId + '\')" title="Edit metadata">&#9998;</button>' +
        '</div>' +
        '<div class="track-meta-editor" id="editor-' + metaId + '" style="display:none;"></div>';
    return html;
}

function toggleVmGroup(btn, id) {
    var el = document.getElementById(id);
    if (!el) return;
    var open = el.style.display === 'none';
    el.style.display = open ? '' : 'none';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('open', open);
}

// The user's own pick of which video is a track. Kept on the release record,
// which a collection re-sync carries over (see syncCollection in api.js).
async function setVideoOverride(releaseId, trackIndex, youtubeId) {
    if (trackIndex === '') return;
    var rel = await dbGet('releases', releaseId);
    if (!rel) return;
    var o = rel.video_overrides || {};
    // A video is one track: drop it from any other track it was picked for.
    Object.keys(o).forEach(function (k) { if (o[k] === youtubeId) delete o[k]; });
    o[parseInt(trackIndex, 10)] = youtubeId;
    rel.video_overrides = o;
    await dbPut('releases', rel);
    renderRelease(releaseId);
}

async function resetVideoOverrides(releaseId) {
    var rel = await dbGet('releases', releaseId);
    if (!rel) return;
    delete rel.video_overrides;
    await dbPut('releases', rel);
    renderRelease(releaseId);
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
        return metaRank(b) - metaRank(a);
    });
    return ranked.length ? ranked[0] : null;
}

// The metadata for a tracklist entry when its videos were matched: the
// chosen video's, else the best-ranked of its other uploads (same audio, so the
// same tempo). Null when the videos were not matched or the track got none.
function metaForMatchedTrack(track, match, metaById, releaseId) {
    if (!match.grouped) return null;
    var row = match.rows.filter(function (x) { return x.track.index === track.index; })[0];
    if (!row || !row.winner) return null;
    var own = metaById[releaseId + '_' + row.winner.youtube_id];
    if (own && metaRank(own) > 1) return own;
    var ranked = [row.winner].concat(row.dupes)
        .map(function (v) { return metaById[releaseId + '_' + v.youtube_id]; })
        .filter(Boolean)
        .sort(function (a, b) { return metaRank(b) - metaRank(a); });
    return ranked.length ? ranked[0] : null;
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
            var badges = !meta ? '' : (
                bpmBadge(meta) +
                (meta.key ? camelotChip(meta.key, {
                    estimated: meta.key_source === 'analysis' && !meta.bpm_verified,
                    musical: meta.key_musical || true
                }) : '') +
                energyBadge(meta));
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
    if (!document.getElementById('vt-panel-' + releaseId)) return;
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
        // Re-render the whole page: the video list is grouped by the tracklist
        // too, not just the side panel. Only while still on this release, and
        // only if there is now something to group by — otherwise renderRelease
        // would ask for the tracklist again, forever.
        var hasTracks = tracklistData.some(function (t) { return t.type_ !== 'heading'; });
        if (hasTracks && _currentView === 'release' && document.getElementById('vt-panel-' + releaseId)) {
            renderRelease(releaseId);
        }
    } catch (err) {
        console.error('Tracklist fetch failed:', err);
    }
}

