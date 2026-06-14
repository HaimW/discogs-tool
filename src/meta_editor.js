// ============ Track Metadata Editor ============

function toggleTrackMetaEditor(metaId) {
    var panel = document.getElementById('editor-' + metaId);
    if (!panel) return;
    if (panel.style.display === 'none') {
        renderTrackMetaEditor(panel, metaId);
        panel.style.display = 'block';
    } else {
        panel.style.display = 'none';
    }
}

function renderTrackMetaEditor(panel, metaId) {
    var idx = metaId.indexOf('_');
    var releaseId = parseInt(metaId.substring(0, idx), 10);
    var youtubeId = metaId.substring(idx + 1);
    getTrackMeta(metaId).then(function (meta) {
        meta = meta || {};
        var camelots = [];
        for (var n = 1; n <= 12; n++) { camelots.push(n + 'A'); camelots.push(n + 'B'); }
        var keyOptions = '<option value="">&mdash;</option>';
        for (var ki = 0; ki < camelots.length; ki++) {
            var k = camelots[ki];
            keyOptions += '<option value="' + k + '"' + (meta.key === k ? ' selected' : '') + '>' + k + '</option>';
        }
        var ratingOptions = '';
        for (var rv = 0; rv <= 5; rv++) {
            var label = rv === 0 ? '&mdash;' : ratingStars(rv);
            ratingOptions += '<option value="' + rv + '"' + ((meta.rating || 0) === rv ? ' selected' : '') + '>' + label + '</option>';
        }
        var tagsStr = (meta.tags || []).join(', ');
        var id = metaId;
        panel.innerHTML =
            '<div class="meta-grid">' +
            '<label class="meta-field"><span>BPM</span><input type="number" step="0.1" min="40" max="220" id="mf-bpm-' + id + '" value="' + (meta.bpm != null ? meta.bpm : '') + '"></label>' +
            '<label class="meta-field"><span>Key (Camelot)</span><select id="mf-key-' + id + '">' + keyOptions + '</select></label>' +
            '<label class="meta-field"><span>Rating</span><select id="mf-rating-' + id + '">' + ratingOptions + '</select></label>' +
            '<label class="meta-field"><span>Energy 1-10</span><input type="number" min="1" max="10" id="mf-energy-' + id + '" value="' + (meta.energy != null ? meta.energy : '') + '"></label>' +
            '<label class="meta-field"><span>Shelf</span><input type="text" id="mf-shelf-' + id + '" value="' + escHtml(meta.shelf || '') + '" placeholder="e.g. A3"></label>' +
            '<label class="meta-field"><span>גובה גלים (m)</span><input type="number" step="0.1" min="0" id="mf-wave-height-' + id + '" value="' + (meta.wave_height != null ? meta.wave_height : '') + '" placeholder="e.g. 1.5"></label>' +
            '<label class="meta-field"><span>כיוון גלים (°)</span><input type="number" step="1" min="0" max="360" id="mf-wave-dir-' + id + '" value="' + (meta.wave_dir != null ? meta.wave_dir : '') + '" placeholder="0–360"></label>' +
            '<label class="meta-field wide"><span>Tags (comma-separated)</span><input type="text" id="mf-tags-' + id + '" value="' + escHtml(tagsStr) + '" placeholder="peak, closer, floor filler"></label>' +
            '<label class="meta-field wide"><span>Notes</span><textarea id="mf-notes-' + id + '" rows="2">' + escHtml(meta.notes || '') + '</textarea></label>' +
            '<label class="meta-field checkbox"><input type="checkbox" id="mf-verified-' + id + '"' + (meta.verified ? ' checked' : '') + '> <span>YouTube link verified</span></label>' +
            '</div>' +
            '<div class="meta-actions">' +
            '<button class="btn" onclick="toggleTrackMetaEditor(\'' + id + '\')">Cancel</button>' +
            '<button class="btn btn-primary" onclick="saveTrackMetaFromForm(\'' + id + '\',' + releaseId + ',\'' + youtubeId + '\')">Save</button>' +
            '</div>';
    });
}

function saveTrackMetaFromForm(metaId, releaseId, youtubeId) {
    var bpmRaw = document.getElementById('mf-bpm-' + metaId).value.trim();
    var bpm = bpmRaw === '' ? null : parseFloat(bpmRaw);
    var energyRaw = document.getElementById('mf-energy-' + metaId).value.trim();
    var energy = energyRaw === '' ? null : parseInt(energyRaw, 10);
    var rating = parseInt(document.getElementById('mf-rating-' + metaId).value, 10);
    var tagsRaw = document.getElementById('mf-tags-' + metaId).value.trim();
    var waveHeightRaw = document.getElementById('mf-wave-height-' + metaId).value.trim();
    var waveHeight = waveHeightRaw === '' ? null : parseFloat(waveHeightRaw);
    var waveDirRaw = document.getElementById('mf-wave-dir-' + metaId).value.trim();
    var waveDir = waveDirRaw === '' ? null : parseInt(waveDirRaw, 10);
    var patch = {
        release_id: releaseId,
        youtube_id: youtubeId,
        bpm: (bpm != null && isFinite(bpm)) ? bpm : null,
        key: document.getElementById('mf-key-' + metaId).value || null,
        rating: rating > 0 ? rating : null,
        energy: (energy != null && isFinite(energy)) ? energy : null,
        shelf: document.getElementById('mf-shelf-' + metaId).value.trim() || '',
        wave_height: (waveHeight != null && isFinite(waveHeight)) ? waveHeight : null,
        wave_dir: (waveDir != null && isFinite(waveDir)) ? waveDir : null,
        tags: tagsRaw ? tagsRaw.split(',').map(function (t) { return t.trim(); }).filter(function (t) { return !!t; }) : [],
        notes: document.getElementById('mf-notes-' + metaId).value.trim() || '',
        verified: document.getElementById('mf-verified-' + metaId).checked
    };
    saveTrackMeta(metaId, patch).then(function () {
        renderCurrentView();
    });
}

