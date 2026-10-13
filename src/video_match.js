// ============ Video ↔ Track Matching ============
//
// A release's video list is community-submitted and can hold dozens of links
// for a record with two tracks: the same song uploaded eight times, mixes that
// are not on this pressing, DJ sets that contain it, 20-second phone clips.
// This decides, for each printed tracklist entry, which video *is* that track,
// which others are just more uploads of it, and which belong to neither.
//
// Pure: no DOM, no IndexedDB. Loaded as a plain <script> in the page, and as a
// CommonJS module by the tests.

// Words that carry no identity. Same list as TITLE_NOISE in views/release.js
// and the analyzer's in desktop-analyzer/crates/core/src/plan.rs.
var VM_NOISE = ['official', 'video', 'audio', 'hd', 'hq', '4k', 'remastered',
    'remaster', 'lyrics', 'lyric', 'full', 'the', 'a', 'vinyl'];

// Words that name a version of a track rather than the track. Inside brackets
// any word counts as one ("(Lewis Lastella Remix)"); outside them only these do,
// so "Davina Don't You Want It Extended" still reads as the Extended version.
var VM_VERSION_WORDS = ['extended', 'overextended', 'club', 'radio', 'dub', 'edit',
    'instrumental', 'remix', 'rmx', 'acapella', 'vocal', 'original', 'performance',
    'reprise', 'rework', 'live', 'single', 'album', 'short', 'long', 'mixed'];

// Bracket words that say nothing about which version it is.
var VM_GENERIC = ['mix', 'version', 'ver', 'feat', 'ft', 'featuring'];

// Share of the track title's words that must appear in the video title. Same
// threshold the release page's BPM/key lookup and the analyzer use.
var VM_TITLE_THRESHOLD = 0.6;

// A video must score at least this against a track to be filed under it.
var VM_MIN_SCORE = 1;

// Two uploads of one track within this many seconds are the same audio.
// Uploads of the same mix differ by up to ~10 s (rips with silence, speed).
var VM_SAME_AUDIO_SECONDS = 12;

// Words, lowercased, apostrophes dropped so "Don't" and "DONT" agree.
function vmWords(s) {
    return String(s == null ? '' : s).toLowerCase()
        .replace(/['’‘`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter(function (w) { return w && VM_NOISE.indexOf(w) === -1; });
}

function vmBracketed(s) {
    var out = [];
    String(s == null ? '' : s).replace(/[(\[]([^)\]]*)[)\]]/g, function (_, inner) {
        out.push(inner);
        return '';
    });
    return out.join(' ');
}

function vmUnbracketed(s) {
    return String(s == null ? '' : s).replace(/[(\[][^)\]]*[)\]]/g, ' ');
}

// The words naming the version: any word in brackets (minus years, catalogue
// numbers and generic words), plus known version words anywhere.
function vmVersion(title) {
    var set = {};
    vmWords(vmBracketed(title)).forEach(function (w) {
        if (/^(19|20)\d\d$/.test(w)) return;           // (1992)
        if (/\d/.test(w)) return;                       // (UR-016) → "ur", "016"
        if (VM_GENERIC.indexOf(w) !== -1) return;
        set[w] = true;
    });
    vmWords(vmUnbracketed(title)).forEach(function (w) {
        if (VM_VERSION_WORDS.indexOf(w) !== -1) set[w] = true;
    });
    // "ur" from "(UR-016)" survives the digit filter on its own; drop
    // two-letter leftovers, which are never version names.
    return Object.keys(set).filter(function (w) { return w.length > 2; }).sort();
}

// "7:50" → 470, "1:02:03" → 3723, "" → null.
function vmSeconds(d) {
    if (typeof d === 'number') return d > 0 ? d : null;
    var parts = String(d == null ? '' : d).trim().split(':');
    if (parts.length < 2) return null;
    var total = 0;
    for (var i = 0; i < parts.length; i++) {
        var n = parseInt(parts[i], 10);
        if (isNaN(n)) return null;
        total = total * 60 + n;
    }
    return total > 0 ? total : null;
}

function vmVideoSeconds(v) {
    var n = Number(v && v.duration);
    return n > 0 ? n : null;
}

// How well a video fits a tracklist entry, or null when the title does not
// name the track at all. Length agreement outweighs version names on purpose:
// "(Extended)" and "(Club)" are often the same 7:50 cut under two labels,
// while a Radio and a Club mix of one song share every word but the length.
function vmScore(track, video) {
    var base = vmWords(vmUnbracketed(track.title));
    if (!base.length) base = vmWords(track.title);
    if (!base.length) return null;
    var have = vmWords(video.title);
    var hits = base.filter(function (w) { return have.indexOf(w) !== -1; }).length;
    var coverage = hits / base.length;
    if (coverage < VM_TITLE_THRESHOLD) return null;

    var score = coverage;

    var tSec = vmSeconds(track.duration);
    var vSec = vmVideoSeconds(video);
    if (tSec && vSec) {
        var diff = Math.abs(tSec - vSec);
        if (diff <= 5) score += 4;
        else if (diff <= 12) score += 2;
        else if (diff > 30) score -= 4;
    }

    var tv = vmVersion(track.title);
    var vv = vmVersion(video.title);
    if (tv.length) {
        var all = tv.every(function (w) { return vv.indexOf(w) !== -1; });
        if (all) score += 3;
        else if (vv.length) score -= 2;
    } else {
        score += vv.length ? -Math.min(3, vv.length) : 1;
    }

    var raw = String(video.title || '');
    if (vSec && vSec < 60) score -= 6;                                  // phone clips
    score -= Math.min(3, (raw.match(/#/g) || []).length);              // #housemusic #vinyl
    if (/\b(mxd|mixed by|dj set|dj mix|live at|b2b|megamix)\b/i.test(raw)) score -= 4;

    return score;
}

function vmSameVersion(a, b) {
    return vmVersion(a.title).join(' ') === vmVersion(b.title).join(' ');
}

// Match a release's videos to its tracklist.
//
//   tracks    tracklist rows: { position, title, duration, index, type }
//   videos    video rows: { youtube_id, title, duration, position }
//   overrides { [track index]: youtube_id } — the user's own picks, which win
//   opts.rank optional fn(video) → number, breaks ties between equal scores
//             (the release page passes "has confirmed BPM/key data")
//
// Returns { grouped, rows: [{ track, winner, dupes }], others, roles }, where
// roles maps youtube_id → 'winner' | 'dupe' | 'other'. When grouping is not
// safe (no tracklist, no more videos than tracks, nothing matched) grouped is
// false and the caller should show the list as it is.
function matchVideos(tracks, videos, overrides, opts) {
    var rank = (opts && opts.rank) || function () { return 0; };
    overrides = overrides || {};

    var seen = {};
    var vids = (videos || []).filter(function (v) {
        if (!v || !v.youtube_id || seen[v.youtube_id]) return false;
        seen[v.youtube_id] = true;
        return true;
    }).sort(function (a, b) { return (a.position || 0) - (b.position || 0); });

    var trks = (tracks || []).filter(function (t) { return t && t.type !== 'heading' && t.type !== 'index'; });

    var flat = { grouped: false, rows: [], others: vids, roles: {} };
    if (!trks.length || vids.length <= trks.length) return flat;

    var byYt = {};
    vids.forEach(function (v) { byYt[v.youtube_id] = v; });

    // The user's picks first; those videos are spoken for.
    var winners = {};
    var taken = {};
    trks.forEach(function (t) {
        var yt = overrides[t.index];
        if (yt && byYt[yt] && !taken[yt]) { winners[t.index] = byYt[yt]; taken[yt] = true; }
    });

    // File each remaining video under the one track it fits best. A tie
    // between two tracks means the titles cannot tell them apart; such a
    // video is left out rather than guessed.
    var filed = {};       // track index → [{ video, score }]
    vids.forEach(function (v) {
        if (taken[v.youtube_id]) return;
        var best = null, bestScore = -Infinity, tie = false;
        trks.forEach(function (t) {
            var s = vmScore(t, v);
            if (s == null) return;
            if (s > bestScore) { best = t; bestScore = s; tie = false; }
            else if (s === bestScore) tie = true;
        });
        if (!best || tie || bestScore < VM_MIN_SCORE) return;
        (filed[best.index] = filed[best.index] || []).push({ video: v, score: bestScore });
    });

    var rows = [];
    var roles = {};
    trks.forEach(function (t) {
        var cands = (filed[t.index] || []).slice().sort(function (a, b) {
            return (b.score - a.score) ||
                (rank(b.video) - rank(a.video)) ||
                ((vmVideoSeconds(b.video) ? 1 : 0) - (vmVideoSeconds(a.video) ? 1 : 0)) ||
                ((a.video.position || 0) - (b.video.position || 0));
        });
        var winner = winners[t.index] || (cands.length ? cands.shift().video : null);
        var dupes = [];
        if (winner) {
            roles[winner.youtube_id] = 'winner';
            var wSec = vmVideoSeconds(winner);
            cands.forEach(function (c) {
                if (c.video === winner) return;
                var cSec = vmVideoSeconds(c.video);
                var same = (wSec && cSec)
                    ? Math.abs(wSec - cSec) <= VM_SAME_AUDIO_SECONDS
                    : vmSameVersion(winner, c.video);
                if (same) { dupes.push(c.video); roles[c.video.youtube_id] = 'dupe'; }
            });
            dupes.sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
        }
        rows.push({ track: t, winner: winner, dupes: dupes });
    });

    if (!rows.some(function (r) { return r.winner; })) return flat;

    var others = vids.filter(function (v) {
        if (roles[v.youtube_id]) return false;
        roles[v.youtube_id] = 'other';
        return true;
    });

    return { grouped: true, rows: rows, others: others, roles: roles };
}

// How much a metadata record is worth showing when several say the same
// thing: a value someone confirmed beats an estimate, and an estimate beats an
// empty record.
function metaRank(meta) {
    if (meta.bpm_verified) return 3;
    if (meta.bpm != null || meta.key) return 2;
    return 1;
}

// opts.rank for matchVideos: prefer the upload that carries BPM/key data.
// metaById is keyed "<releaseId>_<youtubeId>", as track_meta is.
function rankByMeta(metaById, releaseId) {
    return function (v) {
        var m = metaById[releaseId + '_' + v.youtube_id];
        return m ? metaRank(m) : 0;
    };
}

// The videos to play for "Play All" on a release: one per track in tracklist
// order when the videos could be matched, otherwise every video.
function playableVideos(tracks, videos, overrides, opts) {
    var m = matchVideos(tracks, videos, overrides, opts);
    if (!m.grouped) return m.others;
    return m.rows.filter(function (r) { return r.winner; }).map(function (r) { return r.winner; });
}

// Across many releases at once (the Tracks view, shuffle): the set of
// "<releaseId>_<youtubeId>" keys that are only extra uploads of a track
// another video already stands for. Tie-breaks ignore BPM/key data here, so on
// an exact tie the upload kept may differ from the release page's pick — but
// the count, and which track it stands for, are the same.
//
//   videos     every video row
//   tracklist  every tracklist row (each has release_id)
//   releases   release records, for the user's video_overrides
function alternateUploadIds(videos, tracklist, releases) {
    var vidsBy = {}, tracksBy = {}, overridesBy = {};
    (videos || []).forEach(function (v) { (vidsBy[v.release_id] = vidsBy[v.release_id] || []).push(v); });
    (tracklist || []).forEach(function (t) { (tracksBy[t.release_id] = tracksBy[t.release_id] || []).push(t); });
    (releases || []).forEach(function (r) { if (r && r.video_overrides) overridesBy[r.id] = r.video_overrides; });
    var out = {};
    Object.keys(vidsBy).forEach(function (rid) {
        var tracks = (tracksBy[rid] || []).sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
        var m = matchVideos(tracks, vidsBy[rid], overridesBy[rid]);
        if (!m.grouped) return;
        m.rows.forEach(function (row) {
            row.dupes.forEach(function (v) { out[rid + '_' + v.youtube_id] = true; });
        });
    });
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { matchVideos: matchVideos, playableVideos: playableVideos, alternateUploadIds: alternateUploadIds,
        vmScore: vmScore, metaRank: metaRank, rankByMeta: rankByMeta, vmVersion: vmVersion, vmSeconds: vmSeconds, vmWords: vmWords };
}
