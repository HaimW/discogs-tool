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

// Index the track_meta records that have something to show, by id and by video.
// When several releases carry the same video, the first record with data wins.
function queueMetaIndex(metas) {
    var byId = Object.create(null);
    var byVideo = Object.create(null);
    (metas || []).forEach(function (m) {
        if (!m || m.id == null || !queueMetaParts(m)) return;
        byId[m.id] = m;
        var vid = _queueMetaVideoId(m);
        if (vid && !Object.prototype.hasOwnProperty.call(byVideo, vid)) byVideo[vid] = m;
    });
    return { byId: byId, byVideo: byVideo };
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

