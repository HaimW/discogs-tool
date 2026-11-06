// ============ Stats view (F11) ============
//
// Collection value, collectability (Discogs community have/want counts) and
// breakdowns by genre, style, decade, country and format. The breakdowns use
// local data only. The two things that come from Discogs are each fetched only
// when you press their button:
//   - value: one GET /users/{u}/collection/value, kept in config as
//     `collection_value` with Discogs' formatted strings, shown as they are.
//   - collectability: community_have / community_want / community_fetched_at
//     on each release. A sync records them while fetching videos; releases
//     synced before that are filled in by a backfill that can be stopped and
//     picks up where it left off.

var STATS_TOP_N = 10;
var STATS_LIST_N = 10;
// Want/have ratios of releases with only a few wants say little, so the
// ratio list leaves them out.
var STATS_RATIO_MIN_WANT = 5;
// Discogs names that contain ", " themselves. Records store genres and
// styles joined with ", ", so these would otherwise split in two.
var STATS_COMMA_NAMES = ['Folk, World, & Country'];

var _statsBackfill = null;     // { done, total, failed, cancel } while running
var _statsValueBusy = false;

// ---------- pure aggregation ----------

// The values of a list field: a ", "-joined string or an array. Trimmed,
// empty ones dropped, each value once (a double LP is "Vinyl, Vinyl").
function statsSplitList(value) {
    var parts;
    if (Array.isArray(value)) {
        parts = value.map(function (v) { return String(v == null ? '' : v); });
    } else if (value === null || value === undefined || value === '') {
        parts = [];
    } else {
        var s = String(value);
        STATS_COMMA_NAMES.forEach(function (name, i) {
            if (s.indexOf(name) !== -1) {
                s = s.split(name).join('\uE000' + i + '\uE000');
            }
        });
        parts = s.split(',').map(function (p) {
            return p.replace(/\uE000(\d+)\uE000/g, function (m, i) { return STATS_COMMA_NAMES[+i]; });
        });
    }
    var out = [];
    parts.forEach(function (p) {
        p = p.trim();
        if (p && out.indexOf(p) === -1) out.push(p);
    });
    return out;
}

// "1970s" for a year, "Unknown" when there is none (Discogs uses 0).
function statsDecade(year) {
    var y = typeof year === 'number' ? year : parseInt(year, 10);
    if (!Number.isFinite(y) || y < 1000) return 'Unknown';
    return (Math.floor(y / 10) * 10) + 's';
}

// The labels one release counts under for a breakdown field.
function statsValues(rel, field) {
    if (field === 'decade') {
        var d = statsDecade(rel.year);
        return d === 'Unknown' ? [] : [d];
    }
    if (field === 'country') return rel.country ? [String(rel.country).trim()].filter(Boolean) : [];
    if (field === 'format') return statsSplitList(rel.format !== undefined ? rel.format : rel.formats);
    return statsSplitList(rel[field]);   // 'genres', 'styles'
}

function _statsPct(count, total) {
    return total > 0 ? Math.round(count / total * 1000) / 10 : 0;
}

// Counts releases per value of `field`. Returns
//   { total, distinct, max, rows: [{ label, count, pct, kind }] }
// where kind is 'value', 'other' (releases with a value outside the top N;
// `labels` says how many values that folds) or 'unknown' (no value at all).
// pct is the share of all releases. A release with two genres counts in both,
// so for list fields the shares can add up to more than 100.
// order: 'count' (default, largest first) or 'label' (decades, oldest first).
function statsBreakdown(releases, field, topN, order) {
    var total = releases.length;
    var counts = {};
    var unknown = 0;
    var valuesOf = releases.map(function (r) {
        var vals = statsValues(r, field);
        if (!vals.length) unknown++;
        vals.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
        return vals;
    });
    var labels = Object.keys(counts);
    labels.sort(order === 'label'
        ? function (a, b) { return a < b ? -1 : a > b ? 1 : 0; }
        : function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0); });
    var n = (typeof topN === 'number' && topN > 0) ? topN : labels.length;
    // "Other" folds only when it would hold two or more values; one leftover
    // value is shown under its own name instead.
    if (labels.length <= n + 1) n = labels.length;
    var top = labels.slice(0, n);
    var rows = top.map(function (l) {
        return { label: l, count: counts[l], pct: _statsPct(counts[l], total), kind: 'value' };
    });
    if (labels.length > n) {
        var inTop = {};
        top.forEach(function (l) { inTop[l] = true; });
        var other = valuesOf.filter(function (vals) {
            return vals.some(function (v) { return !inTop[v]; });
        }).length;
        rows.push({ label: 'Other', count: other, pct: _statsPct(other, total), kind: 'other', labels: labels.length - n });
    }
    if (unknown) rows.push({ label: 'Unknown', count: unknown, pct: _statsPct(unknown, total), kind: 'unknown' });
    var max = rows.reduce(function (m, r) { return Math.max(m, r.count); }, 0);
    return { total: total, distinct: labels.length, max: max, rows: rows };
}

// Have/want figures over the releases whose counts were fetched.
//   { total, fetched, missing, have, want, mostWanted: [...], byRatio: [...] }
// Each list item: { id, artist, title, year, have, want, ratio }, ratio being
// want / have (have counted as at least 1). byRatio leaves out releases with
// fewer than minWant wants.
function statsCollectability(releases, n, minWant) {
    if (typeof n !== 'number') n = STATS_LIST_N;
    if (typeof minWant !== 'number') minWant = STATS_RATIO_MIN_WANT;
    var fetched = releases.filter(function (r) { return !!r.community_fetched_at; });
    var items = fetched.filter(function (r) {
        return Number.isFinite(r.community_have) && Number.isFinite(r.community_want);
    }).map(function (r) {
        return {
            id: r.id, artist: r.artist || '', title: r.title || '', year: r.year || null,
            have: r.community_have, want: r.community_want,
            ratio: r.community_want / Math.max(r.community_have, 1)
        };
    });
    function byTitle(a, b) {
        var x = (a.artist + ' ' + a.title).toLowerCase(), y = (b.artist + ' ' + b.title).toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
    }
    var mostWanted = items.filter(function (i) { return i.want > 0; }).sort(function (a, b) {
        return b.want - a.want || a.have - b.have || byTitle(a, b);
    }).slice(0, n);
    var byRatio = items.filter(function (i) { return i.want >= minWant; }).sort(function (a, b) {
        return b.ratio - a.ratio || b.want - a.want || byTitle(a, b);
    }).slice(0, n);
    return {
        total: releases.length,
        fetched: fetched.length,
        missing: releases.length - fetched.length,
        have: items.reduce(function (s, i) { return s + i.have; }, 0),
        want: items.reduce(function (s, i) { return s + i.want; }, 0),
        mostWanted: mostWanted,
        byRatio: byRatio
    };
}

// Rough minutes to fetch `count` releases at the authenticated rate limit
// (60 a minute, plus time on the wire).
function statsEtaMinutes(count) {
    if (!count) return 0;
    return Math.max(1, Math.ceil(count * 1.2 / 60));
}

// The config record for a /collection/value response, or null when it holds
// none of the three figures. The formatted strings (currency included) are
// kept as Discogs sent them, never parsed.
function statsValueRecord(data, nowIso) {
    var d = data || {};
    var rec = { key: 'collection_value', minimum: '', median: '', maximum: '', fetched_at: nowIso };
    ['minimum', 'median', 'maximum'].forEach(function (k) {
        if (typeof d[k] === 'string') rec[k] = d[k];
    });
    return (rec.minimum || rec.median || rec.maximum) ? rec : null;
}

function statsPctLabel(pct) {
    if (pct > 0 && pct < 1) return '<1%';
    return Math.round(pct) + '%';
}

// ---------- view ----------

function renderStats() {
    var tok = startViewRender('stats');
    return endViewRender(tok, Promise.all([dbGetAll('releases'), dbGet('config', 'collection_value')]).then(function (res) {
        if (!viewRenderIsCurrent(tok)) return;
        if (_currentView !== 'stats') return;
        var releases = res[0] || [];
        var value = res[1] || null;
        var html = '<div class="stats-page">' +
            '<div class="collection-header"><div class="collection-stats">' +
            '<h1>Stats</h1>' +
            '<span class="stat-count">' + releases.length + ' release' + (releases.length === 1 ? '' : 's') + '</span>' +
            '</div></div>';

        if (!releases.length) {
            html += '<div class="empty-state"><div class="vinyl-icon-huge">&#9898;</div>' +
                '<p class="empty-title">No collection yet</p>' +
                '<p class="empty-subtitle">Sync your Discogs collection to see its stats</p>' +
                '<button class="btn btn-primary btn-large"' + act('click', 'startSync') + '>' +
                '<span class="sync-icon">&#8635;</span> Sync Collection</button></div></div>';
            document.getElementById('app').innerHTML = html;
            return;
        }

        html += '<div class="stats-top">' + _statsValueHtml(value) + _statsCollectabilityHtml(releases) + '</div>';

        html += '<h2 class="stats-section-title">Breakdowns</h2><div class="stats-grid">';
        html += _statsTableHtml('Genre', statsBreakdown(releases, 'genres', STATS_TOP_N), 'A release with several genres counts in each.');
        html += _statsTableHtml('Style', statsBreakdown(releases, 'styles', STATS_TOP_N), 'A release with several styles counts in each.');
        html += _statsTableHtml('Decade', statsBreakdown(releases, 'decade', 0, 'label'), '');
        html += _statsTableHtml('Country', statsBreakdown(releases, 'country', STATS_TOP_N),
            releases.some(function (r) { return !r.country; }) ? 'Country arrives with the video sync; until then a release counts as Unknown.' : '');
        html += _statsTableHtml('Format', statsBreakdown(releases, 'format', STATS_TOP_N), 'A release in several formats counts in each.');
        html += '</div></div>';
        document.getElementById('app').innerHTML = html;
    }));
}

function _statsValueHtml(value) {
    var html = '<section class="stats-card" aria-labelledby="stats-value-h">' +
        '<h2 id="stats-value-h">Collection value</h2>';
    if (value && (value.minimum || value.median || value.maximum)) {
        var ms = dateMs(value.fetched_at);
        html += '<dl class="stats-value">' +
            '<div><dt>Minimum</dt><dd>' + escHtml(value.minimum || '—') + '</dd></div>' +
            '<div><dt>Median</dt><dd>' + escHtml(value.median || '—') + '</dd></div>' +
            '<div><dt>Maximum</dt><dd>' + escHtml(value.maximum || '—') + '</dd></div>' +
            '</dl>' +
            '<p class="stats-note">' + (ms !== null ? 'As of ' + escHtml(new Date(ms).toLocaleString()) + '. ' : '') +
            'Discogs’ estimate from recent marketplace sales.</p>';
    } else {
        html += '<p class="stats-note">Not fetched yet. Discogs estimates it from recent marketplace sales; ' +
            'getting it takes one request.</p>';
    }
    html += '<button class="btn" id="stats-value-btn"' + act('click', 'statsRefreshValue') +
        (_statsValueBusy ? ' disabled' : '') + '>' + (_statsValueBusy ? 'Fetching…' : 'Refresh value') + '</button>';
    return html + '</section>';
}

function _statsCollectabilityHtml(releases) {
    var c = statsCollectability(releases, STATS_LIST_N, STATS_RATIO_MIN_WANT);
    var html = '<section class="stats-card stats-card-wide" aria-labelledby="stats-coll-h">' +
        '<h2 id="stats-coll-h">Collectability</h2>';
    if (c.fetched) {
        html += '<dl class="stats-value">' +
            '<div><dt>Releases counted</dt><dd>' + c.fetched + ' of ' + c.total + '</dd></div>' +
            '<div><dt>Discogs users who have them</dt><dd>' + c.have.toLocaleString() + '</dd></div>' +
            '<div><dt>Who want them</dt><dd>' + c.want.toLocaleString() + '</dd></div>' +
            '</dl>';
    } else {
        html += '<p class="stats-note">How many Discogs users have and want each of your records. ' +
            'Syncs record it from now on; records synced earlier need fetching once.</p>';
    }

    if (_statsBackfill) {
        html += '<p class="stats-note" id="stats-backfill-progress" role="status">' + escHtml(_statsBackfillText()) + '</p>' +
            '<button class="btn"' + act('click', 'statsCancelBackfill') + '>Stop</button>';
    } else if (c.missing) {
        html += '<button class="btn"' + act('click', 'statsStartBackfill') + '>Fetch collectability (' +
            c.missing + ' missing, ~' + statsEtaMinutes(c.missing) + ' min)</button>';
    }

    if (c.fetched) {
        html += '<div class="stats-lists">' +
            _statsReleaseListHtml('Most wanted', c.mostWanted, 'want', 'No release has any wants yet.') +
            _statsReleaseListHtml('Highest want/have ratio', c.byRatio, 'ratio',
                'No release has ' + STATS_RATIO_MIN_WANT + ' or more wants yet.') +
            '</div>';
    }
    return html + '</section>';
}

function _statsReleaseListHtml(title, items, sortedBy, emptyText) {
    var html = '<div class="stats-list"><h3>' + escHtml(title) + '</h3>';
    if (!items.length) return html + '<p class="stats-note">' + escHtml(emptyText) + '</p></div>';
    html += '<table class="stats-table stats-release-table"><thead><tr>' +
        '<th scope="col">Release</th><th scope="col" class="num">Want</th><th scope="col" class="num">Have</th>' +
        (sortedBy === 'ratio' ? '<th scope="col" class="num">Ratio</th>' : '') +
        '</tr></thead><tbody>';
    items.forEach(function (i) {
        html += '<tr><th scope="row"><button class="stats-link"' + act('click', 'navigate', ['release', { releaseId: i.id }]) + '>' +
            escHtml(i.artist) + ' – ' + escHtml(i.title) + '</button></th>' +
            '<td class="num">' + i.want.toLocaleString() + '</td>' +
            '<td class="num">' + i.have.toLocaleString() + '</td>' +
            (sortedBy === 'ratio' ? '<td class="num">' + i.ratio.toFixed(2) + '</td>' : '') +
            '</tr>';
    });
    return html + '</tbody></table></div>';
}

function _statsTableHtml(title, b, note) {
    var html = '<section class="stats-card"><table class="stats-table stats-bars">' +
        '<caption>' + escHtml(title) + '</caption>' +
        '<thead><tr><th scope="col">' + escHtml(title) + '</th>' +
        '<td aria-hidden="true"></td>' +
        '<th scope="col" class="num">Releases</th><th scope="col" class="num">Share</th></tr></thead><tbody>';
    b.rows.forEach(function (r) {
        var width = b.max ? Math.max(1, Math.round(r.count / b.max * 100)) : 0;
        var label = r.kind === 'other' ? 'Other (' + r.labels + ' more)' : r.label;
        html += '<tr class="stats-row-' + r.kind + '"><th scope="row">' + escHtml(label) + '</th>' +
            '<td class="stats-bar-cell" aria-hidden="true"><span class="stats-bar" style="width:' + width + '%"></span></td>' +
            '<td class="num">' + r.count + '</td>' +
            '<td class="num">' + escHtml(statsPctLabel(r.pct)) + '</td></tr>';
    });
    html += '</tbody></table>';
    if (note) html += '<p class="stats-note">' + escHtml(note) + '</p>';
    return html + '</section>';
}

// ---------- collection value ----------

function statsRefreshValue() {
    if (_statsValueBusy) return;
    getConfig().then(function (config) {
        if (!config.token || !config.username) {
            showToast('Set your Discogs token and username first.', 'error');
            return;
        }
        _statsValueBusy = true;
        if (_currentView === 'stats') renderStats();
        return discogsGet('/users/' + encodeURIComponent(config.username) + '/collection/value', config)
            .then(function (data) {
                var rec = statsValueRecord(data, new Date().toISOString());
                if (!rec) throw new Error('Discogs sent no value');
                return dbPut('config', rec).then(function () { showToast('Collection value updated.', 'success'); });
            })
            .catch(function (err) {
                console.error('Collection value failed:', err);
                showToast('Could not get the collection value: ' + err.message, 'error');
            })
            .then(function () {
                _statsValueBusy = false;
                if (_currentView === 'stats') renderStats();
            });
    });
}

// ---------- collectability backfill ----------

function _statsBackfillText() {
    var b = _statsBackfill;
    if (!b) return '';
    var left = b.total - b.done;
    return 'Fetching collectability: ' + b.done + ' of ' + b.total + ' done' +
        (left ? ', about ' + statsEtaMinutes(left) + ' min left' : '') +
        (b.failed ? ' (' + b.failed + ' failed)' : '') + (b.cancel ? ' — stopping…' : '');
}

function _statsSetSyncLock(on) {
    _syncRunning = on;
    var btn = document.getElementById('sync-btn');
    if (btn) btn.disabled = on;
}

function statsCancelBackfill() {
    if (!_statsBackfill) return;
    _statsBackfill.cancel = true;
    var el = document.getElementById('stats-backfill-progress');
    if (el) el.textContent = _statsBackfillText();
}

// Fetches /releases/{id} for every release without community counts and
// writes each as it arrives, so stopping (or closing the page) loses nothing
// and the next run starts with what is still missing. It holds the sync lock
// so a collection sync cannot run alongside it on the same rate limit.
async function statsStartBackfill() {
    if (_statsBackfill) return;
    if (_syncRunning) {
        showToast('A sync is running. Try again when it has finished.', 'error');
        return;
    }
    var config = await getConfig();
    if (!config.token || !config.username) {
        showToast('Set your Discogs token and username first.', 'error');
        return;
    }
    if (_syncRunning) return;  // a sync started while the config loaded
    _statsSetSyncLock(true);
    var b = _statsBackfill = { done: 0, total: 0, failed: 0, cancel: false };
    var inARow = 0;
    var stoppedBy = null;
    try {
        var missing = (await dbGetAll('releases')).filter(function (r) { return !r.community_fetched_at; });
        b.total = missing.length;
        if (_currentView === 'stats') renderStats();
        for (var i = 0; i < missing.length; i++) {
            if (b.cancel) break;
            var rel = missing[i];
            showSyncBanner(_statsBackfillText() + ' — ' + rel.artist + ' - ' + rel.title);
            try {
                var data = await discogsGet('/releases/' + rel.id, config);
                // Re-read: the record may have changed while the request was out.
                var fresh = await dbGet('releases', rel.id);
                if (fresh) {
                    // The same fetch carries the country (as syncVideosInBackground stores it).
                    if (data && data.country) fresh.country = data.country;
                    await dbPut('releases', applyReleaseCommunity(fresh, data));
                }
                inARow = 0;
            } catch (err) {
                console.error('Collectability fetch failed for release ' + rel.id + ':', err);
                b.failed++;
                if (++inARow >= 3) { stoppedBy = err; break; }
            }
            b.done++;
            var el = document.getElementById('stats-backfill-progress');
            if (el) el.textContent = _statsBackfillText();
        }
    } catch (err) {
        stoppedBy = err;
    } finally {
        var summary = b.cancel ? 'Stopped after ' + b.done + ' of ' + b.total + '.'
            : stoppedBy ? 'Stopped: ' + stoppedBy.message
            : 'Collectability fetched for ' + (b.done - b.failed) + ' release' + (b.done - b.failed === 1 ? '' : 's') +
              (b.failed ? ' (' + b.failed + ' failed)' : '') + '.';
        _statsBackfill = null;
        _statsSetSyncLock(false);
        showSyncBanner(summary);
        setTimeout(function () { if (!_syncRunning) hideSyncBanner(); }, 2000);
        showToast(summary, stoppedBy ? 'error' : b.cancel ? 'info' : 'success');
        if (_currentView === 'stats') renderStats();
    }
}
