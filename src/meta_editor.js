// ============ Track Metadata Editor ============

// Render a 0-1 score as a percentage, clamped so an out-of-range value from an
// older record can never show something absurd like "155%".
function pct(v) {
    var n = Number(v);
    if (!isFinite(n)) return '?';
    return Math.round(Math.max(0, Math.min(1, n)) * 100) + '%';
}

// Everything the analyzer recorded about how it reached its answer.
//
// These figures were previously stored and never shown, which made a disputed
// reading indistinguishable from a confident one at the point where you would
// actually fix it. The tempo cross-check in particular is worthless if you
// cannot see that two detectors disagreed and what the other one said.
function metaProvenanceHtml(meta) {
    var rows = [];

    // Both figures are normalised 0-1 by the analyzer, so they are safe to show
    // as percentages. aubio's own confidence is unbounded and is scaled before
    // it ever reaches this record.
    if (meta.bpm_confidence != null) {
        rows.push(['BPM confidence', pct(meta.bpm_confidence) +
            (meta.bpm_confidence <= 0.35 ? ' — low, worth checking by ear' : '')]);
    }
    if (meta.key_strength != null) {
        rows.push(['Key agreement', pct(meta.key_strength) +
            (meta.key_strength <= 0.5 ? ' — the segments disagreed' : '')]);
    }

    // How the tempo was decided. Only interesting when more than one method was
    // involved, which is why the plain single-detector case is not named.
    var METHOD = {
        'beat-grid-confirmed': 'two detectors agreed',
        'beat-grid-rescaled': 'corrected onto the right pulse (the first detector was counting half-beats)',
        'autocorrelation': 'the second detector overruled the first',
        'disputed': 'the two detectors disagreed and neither was convincing'
    };
    if (meta.bpm_method && METHOD[meta.bpm_method]) {
        rows.push(['How', METHOD[meta.bpm_method]]);
    }
    if (meta.bpm_second_opinion != null) {
        rows.push(['Second detector said', meta.bpm_second_opinion + ' BPM']);
    }
    if (meta.bpm_folded_from != null) {
        rows.push(['Before octave correction', meta.bpm_folded_from + ' BPM']);
    }
    if (meta.energy_score != null) {
        rows.push(['Energy score', Number(meta.energy_score).toFixed(2) +
            ' — ranked against the rest of your collection']);
    }
    if (meta.analyzed_at) {
        rows.push(['Analysed', String(meta.analyzed_at).slice(0, 10) +
            (meta.analyzer_version ? ' by v' + meta.analyzer_version : '')]);
    }

    var disputed = meta.bpm_method === 'disputed';
    return '<div class="meta-provenance' + (disputed ? ' meta-provenance-warn' : '') + '">' +
        '<div class="mp-head">Estimated by the desktop analyzer. ' +
        'Tick &ldquo;BPM/key verified&rdquo; once you have checked it.</div>' +
        (rows.length ? '<dl class="mp-rows">' + rows.map(function (r) {
            return '<dt>' + escHtml(r[0]) + '</dt><dd>' + escHtml(String(r[1])) + '</dd>';
        }).join('') + '</dl>' : '') +
        '</div>';
}

// bpm/key as they were when the editor opened, keyed by metaId. Saving compares
// against these so only a genuine edit marks a value as human-entered.
var _metaEditorLoaded = {};

// Clicking a segment of the Camelot wheel: update the dropdown (still the
// source of truth on save) and repaint the wheel so the selection shows.
function metaEditorPickKey(code, metaId) {
    var sel = document.getElementById('mf-key-' + metaId);
    if (!sel) return;
    sel.value = code;
    metaEditorSyncWheel(metaId);
}

function metaEditorSyncWheel(metaId) {
    var sel = document.getElementById('mf-key-' + metaId);
    var wheel = document.getElementById('mf-wheel-' + metaId);
    if (!sel || !wheel) return;
    wheel.innerHTML = camelotWheelSvg(sel.value, 'metaEditorPickKey', metaId);
}

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

        // Remember what was loaded so saving can tell an actual edit from an
        // untouched value. Only a real change stamps the field as human-entered
        // (see saveTrackMetaFromForm) — otherwise editing an unrelated field
        // would permanently lock the desktop analyzer out of re-analysing it.
        _metaEditorLoaded[id] = {
            bpm: meta.bpm != null ? meta.bpm : null,
            key: meta.key || null,
            energy: meta.energy != null ? meta.energy : null
        };

        var estimated = (meta.bpm_source === 'analysis' || meta.key_source === 'analysis' ||
                         meta.energy_source === 'analysis');
        var provenance = estimated && !meta.bpm_verified ? metaProvenanceHtml(meta) : '';

        panel.innerHTML =
            '<div class="meta-grid">' +
            '<label class="meta-field"><span>BPM</span><input type="number" step="0.1" min="40" max="220" id="mf-bpm-' + id + '" value="' + (meta.bpm != null ? meta.bpm : '') + '"></label>' +
            '<label class="meta-field"><span>Key (Camelot)</span><select id="mf-key-' + id + '" onchange="metaEditorSyncWheel(\'' + escJs(id) + '\')">' + keyOptions + '</select></label>' +
            '<label class="meta-field"><span>Rating</span><select id="mf-rating-' + id + '">' + ratingOptions + '</select></label>' +
            '<label class="meta-field"><span>Energy 1-10</span><input type="number" min="1" max="10" id="mf-energy-' + id + '" value="' + (meta.energy != null ? meta.energy : '') + '"></label>' +
            '<label class="meta-field"><span>Shelf</span><input type="text" id="mf-shelf-' + id + '" value="' + escHtml(meta.shelf || '') + '" placeholder="e.g. A3"></label>' +
            '<label class="meta-field wide"><span>Tags (comma-separated)</span><input type="text" id="mf-tags-' + id + '" value="' + escHtml(tagsStr) + '" placeholder="peak, closer, floor filler"></label>' +
            '<label class="meta-field wide"><span>Notes</span><textarea id="mf-notes-' + id + '" rows="2">' + escHtml(meta.notes || '') + '</textarea></label>' +
            '<label class="meta-field checkbox"><input type="checkbox" id="mf-verified-' + id + '"' + (meta.verified ? ' checked' : '') + '> <span>YouTube link verified</span></label>' +
            '<label class="meta-field checkbox"><input type="checkbox" id="mf-bpmverified-' + id + '"' + (meta.bpm_verified ? ' checked' : '') + '> <span>BPM/key verified</span></label>' +
            '<div class="meta-field wide camelot-picker" id="mf-wheel-' + id + '">' + camelotWheelSvg(meta.key, 'metaEditorPickKey', id) + '</div>' +
            provenance +
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
    var key = document.getElementById('mf-key-' + metaId).value || null;
    var patch = {
        release_id: releaseId,
        youtube_id: youtubeId,
        bpm: (bpm != null && isFinite(bpm)) ? bpm : null,
        key: key,
        rating: rating > 0 ? rating : null,
        energy: (energy != null && isFinite(energy)) ? energy : null,
        shelf: document.getElementById('mf-shelf-' + metaId).value.trim() || '',
        tags: tagsRaw ? tagsRaw.split(',').map(function (t) { return t.trim(); }).filter(function (t) { return !!t; }) : [],
        notes: document.getElementById('mf-notes-' + metaId).value.trim() || '',
        verified: document.getElementById('mf-verified-' + metaId).checked,
        bpm_verified: document.getElementById('mf-bpmverified-' + metaId).checked
    };

    // Record provenance so the desktop analyzer knows what it may overwrite.
    // Only a value the user actually changed counts as human-entered — saving
    // an untouched analyzer result must not lock it against future re-analysis.
    // `saveTrackMeta` merges the patch, so omitting a field leaves it as it was.
    var loaded = _metaEditorLoaded[metaId] || { bpm: null, key: null, energy: null };
    if (patch.bpm !== loaded.bpm) patch.bpm_source = patch.bpm != null ? 'manual' : null;
    if (patch.key !== loaded.key) patch.key_source = patch.key != null ? 'manual' : null;
    if (patch.energy !== loaded.energy) patch.energy_source = patch.energy != null ? 'manual' : null;
    delete _metaEditorLoaded[metaId];
    saveTrackMeta(metaId, patch).then(function () {
        renderCurrentView();
    });
}

