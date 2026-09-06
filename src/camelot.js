// ============ Camelot Wheel ============
//
// The Camelot system numbers the circle of fifths 1-12, with A for minor keys
// and B for major. Keys that mix well sit next to each other on the wheel, which
// is why the colours matter: relative major/minor pairs share a hue, so a
// compatible set reads as one colour family at a glance.
//
// This table is generated from the desktop analyzer's `camelot.rs`, which is the
// source of truth for the colour derivation (evenly spaced hues; minor deeper,
// major lighter). To regenerate after changing it there:
//
//     cd desktop-analyzer && cargo test --test dump_colors -- --nocapture
//
// Keeping the values hardcoded on both sides means the two can never drift
// silently — a mismatch shows up as a visibly wrong colour, not a subtle bug.

var CAMELOT_WHEEL = [
    { code: '1A',  color: '#2D75BE', musical: 'G# minor' },
    { code: '1B',  color: '#589EE4', musical: 'B major'  },
    { code: '2A',  color: '#2D2DBE', musical: 'D# minor' },
    { code: '2B',  color: '#5858E4', musical: 'F# major' },
    { code: '3A',  color: '#752DBE', musical: 'A# minor' },
    { code: '3B',  color: '#9E58E4', musical: 'C# major' },
    { code: '4A',  color: '#BE2DBE', musical: 'F minor'  },
    { code: '4B',  color: '#E458E4', musical: 'G# major' },
    { code: '5A',  color: '#BE2D75', musical: 'C minor'  },
    { code: '5B',  color: '#E4589E', musical: 'D# major' },
    { code: '6A',  color: '#BE2D2D', musical: 'G minor'  },
    { code: '6B',  color: '#E45858', musical: 'A# major' },
    { code: '7A',  color: '#BE752D', musical: 'D minor'  },
    { code: '7B',  color: '#E49E58', musical: 'F major'  },
    { code: '8A',  color: '#BEBE2D', musical: 'A minor'  },
    { code: '8B',  color: '#E4E458', musical: 'C major'  },
    { code: '9A',  color: '#75BE2D', musical: 'E minor'  },
    { code: '9B',  color: '#9EE458', musical: 'G major'  },
    { code: '10A', color: '#2DBE2D', musical: 'B minor'  },
    { code: '10B', color: '#58E458', musical: 'D major'  },
    { code: '11A', color: '#2DBE75', musical: 'F# minor' },
    { code: '11B', color: '#58E49E', musical: 'A major'  },
    { code: '12A', color: '#2DBEBE', musical: 'C# minor' },
    { code: '12B', color: '#58E4E4', musical: 'E major'  }
];

// Indexed by code, with a readable text colour worked out per swatch so the
// labels stay legible on both the deep and the light half of the wheel.
var _camelotByCode = {};
(function buildCamelotIndex() {
    for (var i = 0; i < CAMELOT_WHEEL.length; i++) {
        var e = CAMELOT_WHEEL[i];
        e.fg = _contrastColor(e.color);
        _camelotByCode[e.code] = e;
    }
})();

// Relative luminance per WCAG, used only to pick black or white text.
function _contrastColor(hex) {
    var r = parseInt(hex.substr(1, 2), 16) / 255;
    var g = parseInt(hex.substr(3, 2), 16) / 255;
    var b = parseInt(hex.substr(5, 2), 16) / 255;
    function lin(c) { return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    var l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return l > 0.45 ? '#1a1a1a' : '#ffffff';
}

function camelotEntry(code) {
    if (!code) return null;
    return _camelotByCode[String(code).trim().toUpperCase()] || null;
}

function camelotColor(code) {
    var e = camelotEntry(code);
    return e ? e.color : null;
}

// "8A" -> "A minor". Returns '' for anything we don't recognise.
function camelotMusical(code) {
    var e = camelotEntry(code);
    return e ? e.musical : '';
}

// A colour-coded key badge. `opts.estimated` marks a value the desktop analyzer
// produced rather than a human, so an auto-detected key never passes itself off
// as confirmed.
function camelotChip(code, opts) {
    var e = camelotEntry(code);
    if (!e) return '';
    opts = opts || {};
    var title = e.musical + (opts.estimated ? ' — estimated by analysis' : '');
    // The musical name rides inside the coloured chip rather than beside it, so
    // "8B" and "C major" stay one object: they are two notations for the same
    // fact, and splitting them into separate badges reads as two pieces of
    // information. `opts.musical` is the name to show — passed in rather than
    // taken from the table, so a record whose stored name disagrees with the
    // table shows what was actually stored.
    var musical = opts.musical === true ? e.musical : opts.musical;
    return '<span class="track-badge badge-key camelot-chip' +
        (opts.estimated ? ' camelot-chip-estimated' : '') +
        '" style="background:' + e.color + ';color:' + e.fg + ';border-color:' + e.color + '"' +
        ' title="' + escHtml(title) + '">' +
        escHtml(e.code) + (opts.estimated ? '<span class="camelot-est">~</span>' : '') +
        (musical ? '<span class="camelot-musical">' + escHtml(musical) + '</span>' : '') +
        '</span>';
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

// The 1-10 energy figure, shown as a compact meter plus its number.
//
// It is a rank within your own collection, not an absolute measurement, so the
// bar is the honest rendering: it says "this end of my records" rather than
// implying a unit. The tooltip says so outright, because a bare number invites
// the opposite reading.
function energyBadge(meta) {
    if (!meta || meta.energy == null || meta.energy === '') return '';
    var level = Math.max(1, Math.min(10, parseInt(meta.energy, 10) || 0));
    if (!level) return '';
    var estimated = meta.energy_source === 'analysis' && !meta.bpm_verified;
    var title = (estimated ? 'Energy ' + level + '/10, estimated — a rank within your collection'
                           : 'Energy ' + level + '/10');
    return '<span class="track-badge badge-energy' + (estimated ? ' badge-estimated' : '') +
        '" title="' + escHtml(title) + '">' +
        '<span class="energy-meter" aria-hidden="true"><span style="width:' + (level * 10) + '%"></span></span>' +
        level + '</span>';
}

// The wheel itself: two concentric rings of twelve segments, minor (A) inside
// and major (B) outside, exactly as the printed wheels DJs use. Clicking a
// segment calls `onPickFn(code, context)`.
//
// `onPickFn` is the *name* of a global function; `context` is passed straight
// back to it so one handler can serve several wheels on a page. Codes come from
// the table above, never from user input, and `context` is escaped.
function camelotWheelSvg(selectedCode, onPickFn, context) {
    var CX = 130, CY = 130;
    var R_OUT = 124, R_MID = 88, R_IN = 52;
    var selected = camelotEntry(selectedCode);
    var selCode = selected ? selected.code : null;
    var svg = '<svg class="camelot-wheel" viewBox="0 0 260 260" role="group" aria-label="Camelot wheel key picker">';

    for (var n = 1; n <= 12; n++) {
        // Segment n is centred at the top for n=1, going clockwise.
        var a1 = (n - 1) * 30 - 90 - 15;
        var a2 = a1 + 30;
        svg += _wheelSegment(n + 'B', a1, a2, R_MID, R_OUT, CX, CY, selCode, onPickFn, context);
        svg += _wheelSegment(n + 'A', a1, a2, R_IN, R_MID, CX, CY, selCode, onPickFn, context);
    }

    // Centre label: what is currently picked, in both notations.
    svg += '<circle cx="' + CX + '" cy="' + CY + '" r="' + (R_IN - 2) + '" class="camelot-hub"></circle>';
    if (selected) {
        svg += '<text x="' + CX + '" y="' + (CY - 4) + '" class="camelot-hub-code">' + escHtml(selected.code) + '</text>';
        svg += '<text x="' + CX + '" y="' + (CY + 14) + '" class="camelot-hub-name">' + escHtml(selected.musical) + '</text>';
    } else {
        svg += '<text x="' + CX + '" y="' + (CY + 4) + '" class="camelot-hub-name">no key</text>';
    }
    svg += '</svg>';
    return svg;
}

function _wheelSegment(code, a1, a2, rInner, rOuter, cx, cy, selCode, onPickFn, context) {
    var e = _camelotByCode[code];
    var p1 = _polar(cx, cy, rOuter, a1), p2 = _polar(cx, cy, rOuter, a2);
    var p3 = _polar(cx, cy, rInner, a2), p4 = _polar(cx, cy, rInner, a1);
    var d = 'M' + p1.x + ',' + p1.y +
        'A' + rOuter + ',' + rOuter + ' 0 0 1 ' + p2.x + ',' + p2.y +
        'L' + p3.x + ',' + p3.y +
        'A' + rInner + ',' + rInner + ' 0 0 0 ' + p4.x + ',' + p4.y + 'Z';
    var label = _polar(cx, cy, (rInner + rOuter) / 2, (a1 + a2) / 2);
    var isSel = code === selCode;
    var args = "'" + code + "'" + (context != null ? ", '" + escJs(String(context)) + "'" : '');
    var click = onPickFn ? ' onclick="' + onPickFn + '(' + args + ')"' : '';
    return '<g class="camelot-seg' + (isSel ? ' camelot-seg-selected' : '') + '"' + click +
        ' role="button" tabindex="0" aria-label="' + escHtml(code + ', ' + e.musical) + '">' +
        '<title>' + escHtml(code + ' — ' + e.musical) + '</title>' +
        '<path d="' + d + '" fill="' + e.color + '"></path>' +
        '<text x="' + label.x + '" y="' + (label.y + 4) + '" fill="' + e.fg + '">' + code + '</text>' +
        '</g>';
}

function _polar(cx, cy, r, angleDeg) {
    var a = angleDeg * Math.PI / 180;
    return {
        x: Math.round((cx + r * Math.cos(a)) * 10) / 10,
        y: Math.round((cy + r * Math.sin(a)) * 10) / 10
    };
}
