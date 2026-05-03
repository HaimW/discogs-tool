// ============ Track Metadata Helpers ============

function trackMetaId(releaseId, youtubeId) {
    return releaseId + '_' + youtubeId;
}

function getTrackMeta(id) {
    return dbGet('track_meta', id);
}

function saveTrackMeta(id, patch) {
    return getTrackMeta(id).then(function (existing) {
        var rec = existing || { id: id };
        for (var k in patch) rec[k] = patch[k];
        rec.updated_at = new Date().toISOString();
        return dbPut('track_meta', rec);
    });
}

function ratingStars(n) {
    n = Math.max(0, Math.min(5, parseInt(n, 10) || 0));
    var out = '';
    for (var i = 0; i < n; i++) out += '\u2605';
    for (var j = n; j < 5; j++) out += '\u2606';
    return out;
}
