// ============ Queue row BPM / key (F16) ============
//
// Each queue row shows the track's tempo, rounded, and its key as the coloured
// Camelot chip, beside the row number. The values come from track_meta, whose
// ids are "<releaseId>_<youtubeId>" (trackMetaId() in src/meta.js). A queue item
// does not always know its release (older saved queues, some "Play next"
// entries), so a record is found by, in order: the item's own metaId, its
// release + video, and finally the video alone — the same video on another
// release is the same recording.
//
// Pure functions: the panel (src/queue.js) reads track_meta once per draw,
// builds the index here, and fills the rows from it.

// The part of a track_meta record's id after the first "_": its YouTube id.
// Release ids are numbers, YouTube ids may themselves contain "_".
function _queueMetaVideoId(m) {
    if (m.youtube_id) return String(m.youtube_id);
    var id = m.id == null ? '' : String(m.id);
    var cut = id.indexOf('_');
    return cut > 0 ? id.slice(cut + 1) : '';
}

// What a row would show for this record: { bpm, key } with the tempo rounded
// to a whole number and the key as a Camelot code, or null when it has neither.
function queueMetaParts(meta) {
    if (!meta) return null;
    var bpm = null;
    if (meta.bpm != null && meta.bpm !== '') {
        var n = Number(meta.bpm);
        if (isFinite(n) && n > 0) bpm = Math.round(n);
    }
    var key = camelotCode(meta.key) || camelotCode(meta.key_musical);
    if (bpm == null && !key) return null;
    return { bpm: bpm, key: key };
}

// Index track_meta records by id and by video. `hasData(m)` says which records
// count (the queue: BPM or key; setlists: any of BPM, key, energy, rating).
// When several releases carry the same video, the video entry goes to the
// first record with a BPM or key, else the first one that counts at all.
function _metaIndex(metas, hasData) {
    var byId = Object.create(null);
    var byVideo = Object.create(null);
    var videoHasTempoOrKey = Object.create(null);
    (metas || []).forEach(function (m) {
        if (!m || m.id == null || !hasData(m)) return;
        byId[m.id] = m;
        var vid = _queueMetaVideoId(m);
        if (!vid || videoHasTempoOrKey[vid]) return;
        var strong = !!queueMetaParts(m);
        if (strong || !Object.prototype.hasOwnProperty.call(byVideo, vid)) {
            byVideo[vid] = m;
            if (strong) videoHasTempoOrKey[vid] = true;
        }
    });
    return { byId: byId, byVideo: byVideo };
}

// The queue's index: only records with a BPM or a key (what a queue row shows).
function queueMetaIndex(metas) {
    return _metaIndex(metas, queueMetaParts);
}

// Whether a record has anything a setlist row shows: BPM, key, energy, rating.
function setlistMetaHasData(m) {
    if (!m) return false;
    if (queueMetaParts(m)) return true;
    var energy = parseInt(m.energy, 10);
    if (isFinite(energy) && energy > 0) return true;
    var rating = parseInt(m.rating, 10);
    return isFinite(rating) && rating > 0;
}

// The setlist index (F18): like the queue's, but energy- or rating-only records
// count too, so those rows still show what there is. Look items up with
// queueItemMeta.
function setlistMetaIndex(metas) {
    return _metaIndex(metas, setlistMetaHasData);
}

// The metaId to store with a track saved to a setlist: its own, or the
// canonical "<releaseId>_<youtubeId>" when it knows its release. No record
// needs to exist yet: the id is where the metadata editor would put one, and
// the lookup above falls back to the video when it finds nothing there.
function itemMetaId(item) {
    if (!item) return null;
    if (item.metaId) return item.metaId;
    if (item.releaseId != null && item.releaseId !== '' && item.youtubeId) {
        return trackMetaId(item.releaseId, item.youtubeId);
    }
    return null;
}

// The record for a queue item: its metaId, then release + video, then video.
function queueItemMeta(item, index) {
    if (!item || !index) return null;
    var has = Object.prototype.hasOwnProperty;
    if (item.metaId != null && has.call(index.byId, item.metaId)) return index.byId[item.metaId];
    if (item.releaseId != null && item.releaseId !== '' && item.youtubeId) {
        var id = trackMetaId(item.releaseId, item.youtubeId);
        if (has.call(index.byId, id)) return index.byId[id];
    }
    if (item.youtubeId && has.call(index.byVideo, item.youtubeId)) return index.byVideo[item.youtubeId];
    return null;
}

// What screen readers hear for a row: "124 BPM, key 8A".
function queueMetaLabel(parts) {
    if (!parts) return '';
    var bits = [];
    if (parts.bpm != null) bits.push(parts.bpm + ' BPM');
    if (parts.key) bits.push('key ' + parts.key);
    return bits.join(', ');
}

// The contents of a row's .queue-meta cell, or '' when there is nothing to
// show. The visible number and chip are hidden from screen readers, which get
// the one spoken phrase instead.
function queueMetaHtml(meta) {
    var parts = queueMetaParts(meta);
    if (!parts) return '';
    var html = '<span class="queue-meta-vis" aria-hidden="true">';
    if (parts.bpm != null) {
        var estBpm = meta.bpm_source === 'analysis' && !meta.bpm_verified;
        html += '<span class="queue-bpm' + (estBpm ? ' queue-bpm-estimated' : '') + '"' +
            ' title="' + (estBpm ? 'Estimated tempo' : 'Tempo') + ' ' + parts.bpm + ' BPM">' +
            parts.bpm + '</span>';
    }
    if (parts.key) {
        html += camelotChip(parts.key, {
            relative: false,
            estimated: meta.key_source === 'analysis' && !meta.bpm_verified,
        });
    }
    html += '</span><span class="sr-only">' + escHtml(queueMetaLabel(parts)) + '</span>';
    return html;
}

