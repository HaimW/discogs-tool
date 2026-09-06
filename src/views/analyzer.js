// ============ Desktop Analyzer bridge ============
//
// The analyzer is a separate native program: a browser cannot download or run
// one, and nothing here tries to. What it can do is *talk* to one — the
// analyzer serves a small JSON API on loopback when started with `--ui` — so
// this page drives it when it is running and offers the download when it is not.
//
// Everything stays serverless. The requests below go to the user's own machine,
// never to us.

// The analyzer's default port. Kept in step with `--ui-port` in main.rs.
var ANALYZER_PORT = 8733;
var ANALYZER_URL = 'http://127.0.0.1:' + ANALYZER_PORT;
var ANALYZER_RELEASES = 'https://github.com/HaimW/discogs-tool/releases';

var _analyzerPoll = null;
var _analyzerLastLog = 0;

function renderAnalyzer() {
    document.getElementById('app').innerHTML =
        '<div class="analyzer-page">' +
        '<div class="collection-header"><div class="collection-stats">' +
        '<h1>Desktop Analyzer</h1>' +
        '<p class="analyzer-lede">Works out the BPM, key and energy of every track in your ' +
        'collection by listening to the linked audio. It runs on your machine, not here — ' +
        'a browser cannot download or decode YouTube.</p>' +
        '</div></div>' +
        '<div id="analyzer-body"><p class="hint">Looking for a running analyzer…</p></div>' +
        '</div>';
    analyzerProbe();
}

// Is one running? A short timeout, because the common answer is "no" and
// waiting on a closed port for thirty seconds would make the page feel broken.
function analyzerProbe() {
    if (window.location.protocol === 'https:') {
        analyzerMissing();
        return;
    }
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 1500);
    fetch(ANALYZER_URL + '/api/state', { signal: controller.signal })
        .then(function (r) { return r.json(); })
        .then(function (state) {
            clearTimeout(timer);
            // A running analyzer that has not been told to trust this page
            // answers with an error rather than a state. That is the safe
            // default and worth explaining, because "not running" would be a
            // lie and would send you looking in the wrong place.
            analyzerConnected(state);
        })
        .catch(function () {
            clearTimeout(timer);
            // Two different situations arrive here as one: no analyzer running,
            // or one running that has not been told to accept this page. The
            // browser will not say which — it refuses to hand us a cross-origin
            // response it blocked — and deliberately so: letting a page tell
            // the difference would let any site fingerprint what you have
            // running. So the card below covers both.
            analyzerMissing();
        });
}

function analyzerMissing() {
    stopAnalyzerPolling();
    // An https page cannot reach a plain-http server on this machine at all.
    // Browsers block that as mixed content before CORS is considered, so no
    // header the analyzer sends and no flag it is started with can permit it.
    // Advising --allow-origin here would be advising something that cannot work.
    document.getElementById('analyzer-body').innerHTML =
        window.location.protocol === 'https:' ? analyzerHttpsHtml() : analyzerLocalHtml();
}

// The page is served over https, so the bridge is impossible from here.
function analyzerHttpsHtml() {
    return '<div class="analyzer-card">' +
        '<h2>Not available on this address</h2>' +
        '<p>This page is served over <code>https</code>, and a secure page cannot talk to a ' +
        'plain <code>http</code> server on your own machine. Browsers block that outright as ' +
        'mixed content, before any permission the analyzer could grant. There is no setting ' +
        'on either side that changes it.</p>' +
        '<p><strong>Use the analyzer\u2019s own page instead</strong> \u2014 same controls, ' +
        'no browser restriction:</p>' +
        '<div class="analyzer-actions">' +
        '<a class="btn btn-primary" href="' + ANALYZER_URL + '" target="_blank" rel="noopener noreferrer">' +
        'Open ' + ANALYZER_URL + '</a>' +
        '<a class="btn" href="' + ANALYZER_RELEASES + '" target="_blank" rel="noopener noreferrer">Download the analyzer</a>' +
        '</div>' +
        '<h3>How the two fit together</h3>' +
        '<ol class="analyzer-steps">' +
        '<li>Download a fresh backup from the <strong>Backup</strong> page here.</li>' +
        '<li>Run <code>discogs-analyzer --ui</code> and point it at that file.</li>' +
        '<li>Bring the result back with <strong>Restore from backup</strong>.</li>' +
        '</ol>' +
        '<p class="hint">They were always meant to exchange a file rather than talk directly. ' +
        'The controls below appear only when this app is opened over <code>http</code> \u2014 ' +
        'a local copy, or the analyzer serving it.</p>' +
        '</div>';
}

// Served over http, so the bridge can work; it just is not connected yet.
function analyzerLocalHtml() {
    return '<div class="analyzer-card">' +
        '<h2>Not connected</h2>' +
        '<p>Either nothing is running on <code>' + ANALYZER_URL + '</code>, or one is running ' +
        'that has not been told to accept this page. It only listens to pages you name, ' +
        'because a browser reaches <code>127.0.0.1</code> from your own machine \u2014 so being ' +
        'local proves nothing about <em>which</em> page is asking, and these controls read ' +
        'files and start programs.</p>' +
        '<p>Start it like this and the controls will appear here:</p>' +
        '<pre class="analyzer-cmd">discogs-analyzer --ui --allow-origin ' + escHtml(window.location.origin) + '</pre>' +
        '<div class="analyzer-actions">' +
        '<button class="btn btn-primary" onclick="analyzerProbe()">Check again</button>' +
        '<a class="btn" href="' + ANALYZER_RELEASES + '" target="_blank" rel="noopener noreferrer">Download the analyzer</a>' +
        '</div>' +
        '<p class="hint">The analyzer\u2019s own page at <a href="' + ANALYZER_URL + '" ' +
        'target="_blank" rel="noopener noreferrer">' + ANALYZER_URL + '</a> works with no flags.</p>' +
        '</div>';
}

function analyzerConnected(state) {
    var body = document.getElementById('analyzer-body');
    if (!document.getElementById('an-backup')) {
        body.innerHTML =
            '<div class="analyzer-card">' +
            '<h2><span class="analyzer-dot"></span>Connected</h2>' +
            '<p class="hint">Talking to the analyzer on this machine. Paths below are ' +
            'paths on <em>that</em> machine — the browser never sees your files.</p>' +
            '<div class="analyzer-grid">' +
            '<label class="meta-field wide"><span>Backup file</span>' +
            '<input type="text" id="an-backup" placeholder="/path/to/vinyl-backup.json">' +
            '<span class="hint">A path on the analyzer\u2019s machine. Windows paths work too.</span></label>' +
            '<label class="meta-field"><span>Write result to</span>' +
            '<input type="text" id="an-output" value="analysis.json"></label>' +
            '<label class="meta-field"><span>Stop after</span>' +
            '<input type="number" id="an-limit" min="0" placeholder="all tracks"></label>' +
            '<label class="meta-field"><span>Cross-check tempo</span>' +
            '<select id="an-second">' +
            '<option value="always" selected>Always (recommended)</option>' +
            '<option value="unsure">Only when unsure</option>' +
            '<option value="never">Never</option>' +
            '</select></label>' +
            '<label class="meta-field checkbox wide"><input type="checkbox" id="an-force"> ' +
            '<span>Re-analyse tracks I set or verified myself</span></label>' +
            '</div>' +
            '<div class="analyzer-actions">' +
            '<button class="btn" id="an-plan" onclick="analyzerPlan()">Dry run</button>' +
            '<button class="btn btn-primary" id="an-run" onclick="analyzerRun()">Start</button>' +
            '<button class="btn btn-danger" id="an-stop" onclick="analyzerStop()" style="display:none">Stop</button>' +
            '<span class="analyzer-planline" id="an-planline"></span>' +
            '</div>' +
            '<div class="analyzer-bar"><div id="an-bar"></div></div>' +
            '<div class="analyzer-stats" id="an-stats"></div>' +
            '<pre class="analyzer-log" id="an-log"></pre>' +
            '<p class="hint" id="an-note"></p>' +
            '</div>';
    }
    analyzerRenderState(state);
    startAnalyzerPolling();
}

function analyzerOptions() {
    var limit = parseInt(document.getElementById('an-limit').value, 10);
    return {
        backup: document.getElementById('an-backup').value.trim(),
        output: document.getElementById('an-output').value.trim() || 'analysis.json',
        force: document.getElementById('an-force').checked,
        limit: isFinite(limit) && limit > 0 ? limit : null,
        second_opinion: document.getElementById('an-second').value
    };
}

function analyzerPost(path, body) {
    return fetch(ANALYZER_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
}

function analyzerPlan() {
    var o = analyzerOptions();
    if (!o.backup) { analyzerNote('Give the analyzer a path to a backup file first.'); return; }
    document.getElementById('an-planline').textContent = 'checking…';
    analyzerPost('/api/plan', o).then(function (r) {
        if (r.error) { document.getElementById('an-planline').textContent = ''; analyzerNote(r.error); return; }
        analyzerNote('');
        document.getElementById('an-planline').textContent =
            r.analyze + ' to analyse · ' + r.skip + ' already yours · ' + r.review + ' held for review';
    });
}

function analyzerRun() {
    var o = analyzerOptions();
    if (!o.backup) { analyzerNote('Give the analyzer a path to a backup file first.'); return; }
    analyzerNote('');
    analyzerPost('/api/run', o).then(function (r) { if (r.error) analyzerNote(r.error); });
}

function analyzerStop() { analyzerPost('/api/stop'); }

function analyzerNote(message) {
    var el = document.getElementById('an-note');
    if (el) el.textContent = message;
}

function analyzerRenderState(s) {
    var stats = document.getElementById('an-stats');
    if (!stats) return;
    stats.textContent =
        (s.stopping ? 'Stopping after this track…' : (s.activity || 'Idle')) +
        '   ' + s.done + ' / ' + s.total +
        '   analysed ' + s.analyzed + '   failed ' + s.failed;
    document.getElementById('an-bar').style.width = s.total ? (100 * s.done / s.total) + '%' : '0';
    document.getElementById('an-run').disabled = s.running;
    document.getElementById('an-stop').style.display = s.running ? '' : 'none';
    if (s.result) analyzerNote(s.result);
    if (s.log && s.log.length !== _analyzerLastLog) {
        _analyzerLastLog = s.log.length;
        var log = document.getElementById('an-log');
        // The last fifty lines: this is a summary view, and the analyzer's own
        // page is there for the full picture.
        log.textContent = s.log.slice(-50).join('\n');
        log.scrollTop = log.scrollHeight;
    }
}

function startAnalyzerPolling() {
    stopAnalyzerPolling();
    _analyzerPoll = setInterval(function () {
        // Stop as soon as the view changes, or a closed tab keeps polling a
        // port forever.
        if (!document.getElementById('an-log')) { stopAnalyzerPolling(); return; }
        fetch(ANALYZER_URL + '/api/state')
            .then(function (r) { return r.json(); })
            .then(analyzerRenderState)
            .catch(analyzerMissing);
    }, 1000);
}

function stopAnalyzerPolling() {
    if (_analyzerPoll) { clearInterval(_analyzerPoll); _analyzerPoll = null; }
}
