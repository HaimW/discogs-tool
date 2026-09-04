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
                key_source: m.key_source || null,
                bpm_verified: m.bpm_verified || false,
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
            if (c.key) html += camelotChip(c.key, { estimated: c.key_source === 'analysis' && !c.bpm_verified });
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

