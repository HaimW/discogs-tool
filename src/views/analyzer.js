// ============ Desktop Analyzer bridge ============
//
// The analyzer is a separate native program: a browser cannot download or run
// one, and nothing here tries to. What it can do is *talk* to one — the
// analyzer serves a small JSON API on loopback when started with `--ui` — so
// this page drives it when it is running and offers the download when it is not.
//
// The analyzer no longer takes file paths. It keeps its backup, result and
// resume file in its own data folder, and everything reaches it as an upload:
// this page sends the collection it already holds (the same document the
// Backup page downloads), and loads the result back through the same code as
// Restore from backup. The flow and wording mirror the analyzer's own page
// (desktop-analyzer/crates/cli/src/ui/page.html).
//
// Everything stays serverless. The requests below go to the user's own machine,
// never to us.

// The analyzer's default port. Kept in step with `--ui-port` in main.rs.
var ANALYZER_PORT = 8733;
var ANALYZER_URL = 'http://127.0.0.1:' + ANALYZER_PORT;
var ANALYZER_RELEASES = 'https://github.com/HaimW/discogs-tool/releases';
// The analyzer refuses a larger upload (MAX_UPLOAD_BODY in ui/http.rs).
var ANALYZER_MAX_UPLOAD = 64 * 1024 * 1024;

var _analyzerPoll = null;
var _analyzerLastLog = 0;
// The view-render token of the analyzer page on screen (src/view_state.js).
// Every async reply checks it, so one that lands after the user has left (or
// after the page was drawn again) draws nothing.
var _analyzerToken = 0;
var _analyzerWasRunning = false;
var _analyzerLastResult = null;
var _analyzerSent = false;      // a backup was sent from this page view
var _analyzerAudio = null;      // last GET /api/audio reply
var _analyzerAudioBusy = false; // a delete is in flight
var _analyzerSending = false;   // a backup upload is in flight
var _analyzerStarting = false;  // a POST /api/run is in flight
var _analyzerPollFailures = 0;  // consecutive failed polls

function renderAnalyzer() {
    _analyzerToken = startViewRender('analyzer');
    stopAnalyzerPolling();
    _analyzerLastLog = 0;
    _analyzerWasRunning = false;
    _analyzerLastResult = null;
    _analyzerSent = false;
    _analyzerAudio = null;
    _analyzerAudioBusy = false;
    _analyzerSending = false;
    _analyzerStarting = false;
    _analyzerPollFailures = 0;
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

// May a reply that started under `token` still draw?
function analyzerLive(token) {
    return token === _analyzerToken &&
        (typeof viewRenderIsCurrent !== 'function' || viewRenderIsCurrent(token)) &&
        !!document.getElementById('analyzer-body');
}

// The same, for a reply that draws into the connected controls: those are
// gone once the "Not connected" card has replaced them.
function analyzerUiLive(token) {
    return analyzerLive(token) && !!document.getElementById('an-run');
}

// Is one running? A short timeout, because the common answer is "no" and
// waiting on a closed port for thirty seconds would make the page feel broken.
function analyzerProbe() {
    var token = _analyzerToken;
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
            if (analyzerLive(token)) analyzerConnected(state);
        })
        .catch(function () {
            clearTimeout(timer);
            // Two different situations arrive here as one: no analyzer running,
            // or one running that has not been told to accept this page. The
            // browser will not say which — it refuses to hand us a cross-origin
            // response it blocked — and deliberately so: letting a page tell
            // the difference would let any site fingerprint what you have
            // running. So the card below covers both.
            if (analyzerLive(token)) analyzerMissing();
        });
}

function analyzerMissing() {
    stopAnalyzerPolling();
    // An https page cannot reach a plain-http server on this machine at all.
    // Browsers block that as mixed content before CORS is considered, so no
    // header the analyzer sends and no flag it is started with can permit it.
    // Advising --allow-origin here would be advising something that cannot work.
    var body = document.getElementById('analyzer-body');
    if (!body) return;
    body.innerHTML = window.location.protocol === 'https:' ? analyzerHttpsHtml() : analyzerLocalHtml();
}

// The page is served over https, so the bridge is impossible from here.
function analyzerHttpsHtml() {
    var url = escHtml(ANALYZER_URL);
    return '<div class="analyzer-card">' +
        '<h2>Not available on this address</h2>' +
        '<p>This page is served over <code>https</code>, and a secure page cannot talk to a ' +
        'plain <code>http</code> server on your own machine. Browsers block that outright as ' +
        'mixed content, before any permission the analyzer could grant. There is no setting ' +
        'on either side that changes it.</p>' +
        '<p><strong>Use the analyzer’s own page instead</strong> — same controls, ' +
        'no browser restriction:</p>' +
        '<div class="analyzer-actions">' +
        '<a class="btn btn-primary" href="' + url + '" target="_blank" rel="noopener noreferrer">' +
        'Open ' + url + '</a>' +
        '<a class="btn" href="' + ANALYZER_RELEASES + '" target="_blank" rel="noopener noreferrer">Download the analyzer</a>' +
        '</div>' +
        '<h3>How the two fit together</h3>' +
        '<ol class="analyzer-steps">' +
        '<li>Download a fresh backup from the <strong>Backup</strong> page here.</li>' +
        '<li>Run <code>discogs-analyzer --ui</code>, open its page, and use ' +
        '<strong>Choose backup file</strong> to give it that backup.</li>' +
        '<li>Press <strong>Dry run</strong> to see what it will do, then <strong>Start</strong>.</li>' +
        '<li>When it has finished, use <strong>Download result</strong>, and bring the file back ' +
        'here with <strong>Restore from backup</strong>.</li>' +
        '</ol>' +
        '<p class="hint">They were always meant to exchange a file rather than talk directly. ' +
        'The controls below appear only when this app is opened over <code>http</code> — ' +
        'a local copy, or the analyzer serving it.</p>' +
        '</div>';
}

// Served over http, so the bridge can work; it just is not connected yet.
function analyzerLocalHtml() {
    var url = escHtml(ANALYZER_URL);
    return '<div class="analyzer-card">' +
        '<h2>Not connected</h2>' +
        '<p>Either nothing is running on <code>' + url + '</code>, or one is running ' +
        'that has not been told to accept this page. It only listens to pages you name, ' +
        'because a browser reaches <code>127.0.0.1</code> from your own machine — so being ' +
        'local proves nothing about <em>which</em> page is asking, and these controls hand it ' +
        'your collection and start downloads.</p>' +
        '<p>Start it like this and the controls will appear here:</p>' +
        '<pre class="analyzer-cmd">discogs-analyzer --ui --allow-origin ' + escHtml(window.location.origin) + '</pre>' +
        '<div class="analyzer-actions">' +
        '<button class="btn btn-primary"' + act('click', 'analyzerProbe') + '>Check again</button>' +
        '<a class="btn" href="' + ANALYZER_RELEASES + '" target="_blank" rel="noopener noreferrer">Download the analyzer</a>' +
        '</div>' +
        '<p class="hint">The analyzer’s own page at <a href="' + url + '" ' +
        'target="_blank" rel="noopener noreferrer">' + url + '</a> works with no flags.</p>' +
        '</div>';
}

function analyzerConnectedHtml() {
    var url = escHtml(ANALYZER_URL);
    return '<div class="analyzer-card">' +
        '<h2><span class="analyzer-dot"></span>Connected</h2>' +
        '<p class="hint">Talking to the analyzer on this machine. It keeps your backup, the ' +
        'result and its resume file in its own data folder<span id="an-datadir"></span>.</p>' +

        '<h3>Your collection</h3>' +
        '<div class="analyzer-actions">' +
        '<button class="btn btn-primary" id="an-send"' + act('click', 'analyzerSend') + '>Send my collection</button>' +
        '<button class="btn" id="an-pick-backup"' + act('click', 'analyzerPickBackup') + '>Choose backup file…</button>' +
        '<input type="file" id="an-backup-file" accept=".json,application/json" hidden ' +
        'aria-label="Backup file to send"' + act('change', 'analyzerBackupFileChosen', [ACT_THIS]) + '>' +
        '</div>' +
        '<p class="hint">Sends what this app holds, as the same file the Backup page downloads ' +
        '(your Discogs token is never in it) — or a backup file you downloaded earlier. ' +
        'Records are written back whole, so send a fresh one: an old backup can undo newer edits.</p>' +
        '<p class="analyzer-status" id="an-backup-status" role="status" aria-live="polite"></p>' +

        '<h3>What to analyse</h3>' +
        '<div class="analyzer-grid">' +
        '<label class="meta-field"><span>Stop after this many tracks</span>' +
        '<input type="number" id="an-limit" min="0" placeholder="all of them"></label>' +
        '<label class="meta-field"><span>Cross-check tempo</span>' +
        '<select id="an-second">' +
        '<option value="always" selected>Always — every track (recommended)</option>' +
        '<option value="unsure">Only when the first reading is unsure</option>' +
        '<option value="never">Never — one detector</option>' +
        '</select></label>' +
        '<label class="meta-field checkbox wide"><input type="checkbox" id="an-force"> ' +
        '<span>Re-analyse tracks I set or verified myself ' +
        '<span class="hint">Off by default. This overwrites your own BPM and key.</span></span></label>' +
        '<label class="meta-field checkbox wide"><input type="checkbox" id="an-keep-audio" ' +
        'aria-describedby="an-keep-audio-hint"> ' +
        '<span>Keep the downloaded audio ' +
        '<span class="hint" id="an-keep-audio-hint">Keeps the downloaded audio on this computer, in the ' +
        'analyzer’s data folder. A later run — after a detection update, say — reuses it ' +
        'instead of downloading from YouTube again: faster, and no rate limits. A few MB a ' +
        'track, roughly 10–20 GB for a few thousand tracks. Off by default; for your ' +
        'own analysis only.</span></span></label>' +
        '</div>' +
        '<div class="analyzer-actions">' +
        '<span class="hint" id="an-audio-stats">Saved audio: …</span>' +
        '<button class="btn btn-danger" id="an-audio-delete" disabled' + act('click', 'analyzerDeleteAudio') + '>Delete saved audio</button>' +
        '</div>' +
        '<p class="analyzer-status" id="an-audio-status" role="status" aria-live="polite"></p>' +
        '<p class="hint">Speed, retries, yt-dlp and signed-in downloads are set on the analyzer’s ' +
        'own page, <a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>.</p>' +

        '<h3>Run</h3>' +
        '<div class="analyzer-actions">' +
        '<button class="btn" id="an-plan"' + act('click', 'analyzerPlan') + '>Dry run</button>' +
        '<button class="btn btn-primary" id="an-run"' + act('click', 'analyzerRun') + '>Start</button>' +
        '<button class="btn btn-danger" id="an-stop" hidden' + act('click', 'analyzerStop') + '>Stop</button>' +
        '<span class="analyzer-planline" id="an-planline"></span>' +
        '</div>' +
        '<p id="an-resumeline" hidden></p>' +
        '<div class="analyzer-actions" id="an-resume-import-wrap" hidden>' +
        '<button class="btn" id="an-resume-import"' + act('click', 'analyzerPickLedger') + '>Import earlier progress</button>' +
        '</div>' +
        '<p class="analyzer-status" id="an-import-status" role="status" aria-live="polite"></p>' +
        '<div class="analyzer-banner" id="an-result" role="status" aria-live="polite" hidden></div>' +
        '<div class="analyzer-actions" id="an-result-actions" hidden>' +
        '<button class="btn btn-primary" id="an-load"' + act('click', 'analyzerLoadResult') + '>Load results into the app</button>' +
        '<a class="btn" id="an-download" href="' + url + '/api/result" download="analysis.json" target="_blank" rel="noopener noreferrer">Download result</a>' +
        '</div>' +
        '<div class="analyzer-bar"><div id="an-bar"></div></div>' +
        '<div class="analyzer-stats" id="an-stats"></div>' +
        '<pre class="analyzer-log" id="an-log"></pre>' +
        '<p class="hint"><button class="btn-text" id="an-import"' + act('click', 'analyzerPickLedger') + '>' +
        'Import earlier progress</button> — pick an existing <code>.ledger.json</code> resume file, ' +
        'so a run carries on where an earlier one stopped instead of starting over.</p>' +
        '<input type="file" id="an-ledger-file" accept=".json,application/json" hidden ' +
        'aria-label="Resume file to import"' + act('change', 'analyzerLedgerChosen', [ACT_THIS]) + '>' +
        '</div>' +

        '<dialog class="analyzer-dialog" id="an-restart-dialog" aria-labelledby="an-restart-title" ' +
        'aria-describedby="an-restart-text an-restart-reason">' +
        '<h2 class="modal-title modal-title-danger" id="an-restart-title">Start over from scratch?</h2>' +
        '<p class="modal-body" id="an-restart-text"></p>' +
        '<p class="modal-note" id="an-restart-reason"></p>' +
        '<div class="modal-actions">' +
        '<button class="btn" id="an-restart-import"' + act('click', 'analyzerRestartImport') + '>Import earlier progress</button>' +
        '<button class="btn btn-danger" id="an-restart-fresh"' + act('click', 'analyzerRestartFresh') + '>Start from scratch</button>' +
        '<button class="btn" id="an-restart-cancel"' + act('click', 'analyzerRestartCancel') + '>Cancel</button>' +
        '</div>' +
        '</dialog>';
}

function analyzerConnected(state) {
    var token = _analyzerToken;
    if (!document.getElementById('an-run')) {
        document.getElementById('analyzer-body').innerHTML = analyzerConnectedHtml();
        analyzerRefreshFiles(token);
        analyzerRefreshAudio(token);
    }
    analyzerRenderState(state);
    startAnalyzerPolling(token);
}

// ---- Talking to the analyzer ---------------------------------------------

// A JSON POST. Resolves to { status, body } whatever happens: refusals such as
// 409 restart_needs_confirmation carry a body the page needs to read.
function analyzerPost(path, body) {
    return fetch(ANALYZER_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    }).then(function (r) {
        return r.json().then(function (j) {
            return { status: r.status, body: j && typeof j === 'object' ? j : {} };
        }, function () { return { status: r.status, body: {} }; });
    }).catch(function () {
        return { status: 0, body: { error: 'Could not reach the analyzer. Is it still running?' } };
    });
}

// Sends a Blob or File as the body. The browser gives it a Content-Length,
// which the analyzer requires of an upload. Resolves to analyzerReadReply's
// object; never rejects.
function analyzerUpload(path, blob) {
    return fetch(ANALYZER_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: blob
    }).then(function (r) {
        return r.text().then(function (text) { return analyzerReadReply(r.status, text); });
    }).catch(function () {
        return { error: 'Could not send the file. It may be too large, or the analyzer has stopped.' };
    });
}

// An upload's reply as an object: the server's JSON when it sent some,
// otherwise a readable error.
function analyzerReadReply(status, text) {
    var j = analyzerParseJson(text);
    if (!j || typeof j !== 'object' || Array.isArray(j)) j = {};
    var ok = status >= 200 && status < 300;
    if (!ok && !j.error) {
        j.error = status === 413
            ? 'That file is too large (the limit is 64 MB).'
            : 'The analyzer refused the file (HTTP ' + status + ').';
    }
    if (ok && !j.ok && !j.error) j.error = 'Unexpected reply from the analyzer.';
    return j;
}

function analyzerParseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
}

function analyzerErrorText(r) {
    if (!r) return 'Unexpected reply from the analyzer.';
    return r.code === 'no_backup' ? 'Send your collection to the analyzer first.' : String(r.error);
}

function analyzerSetStatus(id, message, bad) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = message || '';
    el.className = 'analyzer-status' + (bad ? ' analyzer-status-err' : '');
}

function analyzerBanner(message, bad) {
    var el = document.getElementById('an-result');
    if (!el) return;
    el.textContent = message || '';
    el.className = 'analyzer-banner ' + (bad ? 'analyzer-warn' : 'analyzer-ok');
    el.hidden = !message;
}

// The same words the analyzer's page treats as a failed run.
function analyzerResultIsBad(message) {
    return /failed|could not|not found/i.test(String(message || ''));
}

function analyzerOptions() {
    var limit = parseInt(document.getElementById('an-limit').value, 10);
    return {
        force: document.getElementById('an-force').checked,
        // Off unless ticked: kept audio is gigabytes.
        keep_audio: document.getElementById('an-keep-audio').checked,
        limit: isFinite(limit) && limit > 0 ? limit : null,
        second_opinion: document.getElementById('an-second').value
    };
}

// ---- What the analyzer has -------------------------------------------------

function analyzerRefreshFiles(token) {
    return fetch(ANALYZER_URL + '/api/files')
        .then(function (r) { return r.json(); })
        .then(function (f) {
            if (!analyzerUiLive(token) || !f || f.error) return;
            var dir = document.getElementById('an-datadir');
            if (dir) dir.textContent = f.data_dir ? ' (' + f.data_dir + ')' : '';
            document.getElementById('an-result-actions').hidden = f.result !== true;
            if (!_analyzerSent && f.backup) {
                analyzerSetStatus('an-backup-status', 'The analyzer already has a backup (' +
                    f.backup.videos + ' videos). Send a fresh one if you have changed anything since.');
            }
        })
        .catch(function () { /* the poller reports a dead analyzer */ });
}

// ---- Sending the collection --------------------------------------------------

// Disables the two ways of sending a backup while one is on its way.
function analyzerSendBusy(busy) {
    ['an-send', 'an-pick-backup'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.disabled = busy || _analyzerWasRunning;
    });
}

function analyzerSend() {
    var token = _analyzerToken;
    if (_analyzerSending) return;
    _analyzerSending = true;
    analyzerSendBusy(true);
    analyzerSetStatus('an-backup-status', 'Preparing your collection…');
    buildFullBackup().then(function (payload) {
        if (!analyzerUiLive(token)) { _analyzerSending = false; return; }
        var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        analyzerSendBackup(token, blob, 'Sent');
    }, function (err) {
        _analyzerSending = false;
        if (analyzerUiLive(token)) {
            analyzerSendBusy(false);
            analyzerSetStatus('an-backup-status', 'Could not read your collection: ' + (err && err.message), true);
        }
    });
}

function analyzerPickBackup() {
    var input = document.getElementById('an-backup-file');
    if (!input) return;
    input.value = '';
    input.click();
}

function analyzerBackupFileChosen(input) {
    var file = input.files && input.files[0];
    if (!file || _analyzerSending) return;
    _analyzerSending = true;
    analyzerSendBusy(true);
    analyzerSendBackup(_analyzerToken, file, 'Sent ' + file.name);
}

// Uploads a backup and, once the analyzer has it, runs the dry run.
function analyzerSendBackup(token, blob, label) {
    if (blob.size > ANALYZER_MAX_UPLOAD) {
        _analyzerSending = false;
        analyzerSendBusy(false);
        analyzerSetStatus('an-backup-status', 'That is too large to send (the limit is 64 MB).', true);
        return;
    }
    analyzerSetStatus('an-backup-status', 'Sending…');
    analyzerUpload('/api/backup', blob).then(function (r) {
        _analyzerSending = false;
        if (!analyzerUiLive(token)) return;
        analyzerSendBusy(false);
        if (!r.ok) {
            analyzerSetStatus('an-backup-status', analyzerErrorText(r), true);
            return;
        }
        _analyzerSent = true;
        analyzerSetStatus('an-backup-status', label + ': ' + r.videos + ' videos');
        analyzerPlan();
    });
}

// ---- Dry run -------------------------------------------------------------------

// The dry run's counts as the analyzer's page shows them: each count (null for
// a plain note) and the text after it.
function analyzerPlanParts(r) {
    var parts = [];
    function part(count, label, sep) {
        parts.push({ count: Number(count) || 0, text: ' ' + label + (sep ? ' · ' : '') });
    }
    part(r.analyze, 'to analyse', true);
    if (r.will_run < r.analyze) {
        parts.push({ count: null, text: '(this run stops after ' + r.will_run + ') · ' });
    }
    part(r.done, 'already analysed', true);
    part(r.exhausted, r.exhausted
        ? 'failed too often (raise Retries per track on the analyzer’s own page to retry)'
        : 'failed too often', true);
    part(r.skip, 'already yours', true);
    part(r.review, 'held for review', false);
    return parts;
}

function analyzerPlanText(r) {
    return analyzerPlanParts(r).map(function (p) {
        return (p.count === null ? '' : String(p.count)) + p.text;
    }).join('');
}

// How to show the dry run's resume sentence. A first ever run with no resume
// file is worth a note; no resume file while the backup already holds analysed
// tracks, or a file that would be thrown away, means hours of work are about
// to be redone — a warning, with the way to bring earlier progress back.
function analyzerResumeView(r) {
    var resume = r && r.resume;
    var text = resume && resume.message ? String(resume.message) : '';
    if (!text) return { text: '', kind: 'hint', offerImport: false };
    var st = resume.status;
    var firstRun = st === 'fresh' && !r.analysed_in_backup;
    var kind = st === 'resumed' ? 'hint' : firstRun ? 'ok' : 'warn';
    return { text: text, kind: kind, offerImport: kind === 'warn' };
}

function analyzerPlan() {
    var token = _analyzerToken;
    var line = document.getElementById('an-planline');
    if (!line) return;
    line.textContent = 'checking…';
    analyzerPost('/api/plan', analyzerOptions()).then(function (res) {
        if (!analyzerUiLive(token)) return;
        var r = res.body;
        var resume = document.getElementById('an-resumeline');
        var importWrap = document.getElementById('an-resume-import-wrap');
        line = document.getElementById('an-planline');
        if (r.error || res.status !== 200) {
            line.textContent = '';
            resume.hidden = true;
            importWrap.hidden = true;
            analyzerBanner(r.error ? analyzerErrorText(r) : 'Unexpected reply from the analyzer.', true);
            return;
        }
        analyzerBanner('');
        // Built from nodes, not markup: the resume message carries a path, and
        // nothing from outside is ever parsed as HTML.
        line.textContent = '';
        analyzerPlanParts(r).forEach(function (p) {
            if (p.count !== null) {
                var b = document.createElement('b');
                b.textContent = String(p.count);
                line.appendChild(b);
            }
            line.appendChild(document.createTextNode(p.text));
        });
        var view = analyzerResumeView(r);
        resume.textContent = view.text;
        resume.className = view.kind === 'hint' ? 'hint'
            : 'analyzer-banner ' + (view.kind === 'ok' ? 'analyzer-ok' : 'analyzer-warn');
        resume.hidden = !view.text;
        importWrap.hidden = !view.offerImport;
    });
}

// ---- Run -------------------------------------------------------------------------

// What a reply to POST /api/run means for the page.
function analyzerRunOutcome(status, body) {
    body = body && typeof body === 'object' ? body : {};
    if (status === 409 && body.code === 'restart_needs_confirmation') {
        return { action: 'confirm', restart: body.restart || {} };
    }
    if (body.error) return { action: 'error', message: analyzerErrorText(body) };
    if (status < 200 || status >= 300 || !body.ok) {
        return { action: 'error', message: 'Unexpected reply from the analyzer' + (status ? ' (HTTP ' + status + ').' : '.') };
    }
    return { action: 'started' };
}

function analyzerRun() { analyzerStartRun(false); }

function analyzerStartRun(confirmRestart) {
    var token = _analyzerToken;
    var runBtn = document.getElementById('an-run');
    if (!runBtn || _analyzerStarting) return;
    _analyzerStarting = true;
    runBtn.disabled = true;
    analyzerBanner('');
    var o = analyzerOptions();
    if (confirmRestart) o.confirm_restart = true;
    analyzerPost('/api/run', o).then(function (res) {
        _analyzerStarting = false;
        if (!analyzerUiLive(token)) return;
        var out = analyzerRunOutcome(res.status, res.body);
        // Until the next poll says otherwise; a started run keeps it disabled.
        document.getElementById('an-run').disabled = out.action === 'started' || _analyzerWasRunning;
        // A new run's ending is news even if it reads like the last one's.
        if (out.action === 'started') _analyzerLastResult = null;
        if (out.action === 'confirm' && !confirmRestart) analyzerConfirmRestart(out.restart);
        else if (out.action === 'confirm') analyzerBanner(String(res.body.error), true);
        else if (out.action === 'error') analyzerBanner(out.message, true);
    });
}

// The restart dialog's two sentences, from the 409 reply's `restart`.
function analyzerRestartText(restart) {
    restart = restart || {};
    var analyze = restart.analyze || 0;
    var inBackup = restart.analysed_in_backup || 0;
    var discarded = restart.discarded_completed || 0;
    var text = 'This will analyse all ' + analyze + ' tracks from scratch' +
        (inBackup > 0 ? ', including ' + inBackup + ' that are already analysed.' : '.');
    var reason;
    if (restart.status === 'fresh') {
        reason = 'No resume file was found in the analyzer’s data folder, so earlier progress is not known to this run.';
    } else if (restart.status === 'discarded_settings') {
        reason = 'The resume file (' + discarded + ' finished tracks) would be discarded because it was ' +
            'written with a different Cross-check (second detector) setting.';
    } else {
        reason = 'The resume file' + (discarded ? ' (' + discarded + ' finished tracks)' : '') +
            ' would be discarded because it is unreadable or from an older version.';
    }
    return { text: text, reason: reason };
}

function analyzerConfirmRestart(restart) {
    var t = analyzerRestartText(restart);
    var dlg = document.getElementById('an-restart-dialog');
    if (!dlg || typeof dlg.showModal !== 'function') {
        if (window.confirm(t.text + '\n\n' + t.reason + '\n\nStart from scratch anyway?')) analyzerStartRun(true);
        return;
    }
    document.getElementById('an-restart-text').textContent = t.text;
    document.getElementById('an-restart-reason').textContent = t.reason;
    dlg.showModal();
    // The safe choice first. Esc closes the dialog: that is Cancel too.
    document.getElementById('an-restart-cancel').focus();
}

function analyzerCloseRestart() {
    var dlg = document.getElementById('an-restart-dialog');
    if (dlg && dlg.open) dlg.close();
}

function analyzerRestartCancel() { analyzerCloseRestart(); }

function analyzerRestartFresh() {
    analyzerCloseRestart();
    analyzerStartRun(true);
}

// Opens the file picker inside the click itself, so it keeps the user's
// activation.
function analyzerRestartImport() {
    analyzerCloseRestart();
    analyzerPickLedger();
}

function analyzerStop() {
    var stop = document.getElementById('an-stop');
    if (stop) stop.disabled = true;
    analyzerPost('/api/stop');
}

// ---- Import earlier progress -----------------------------------------------------

function analyzerPickLedger() {
    var input = document.getElementById('an-ledger-file');
    if (!input) return;
    input.value = '';
    input.click();
}

function analyzerLedgerChosen(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size > ANALYZER_MAX_UPLOAD) {
        analyzerSetStatus('an-import-status', file.name + ' is too large (the limit is 64 MB). Is it really a resume file?', true);
        return;
    }
    analyzerImportLedger(file, false);
}

// The Cross-check options' labels by value, as shown.
function analyzerSecondLabels() {
    var labels = {};
    var sel = document.getElementById('an-second');
    if (sel) Array.prototype.forEach.call(sel.options, function (o) { labels[o.value] = o.textContent; });
    return labels;
}

// What a reply to POST /api/ledger means for the page. `labels` maps each
// Cross-check value to its label.
function analyzerLedgerOutcome(r, labels) {
    r = r || {};
    if (r.code === 'ledger_exists') {
        return {
            action: 'confirm_replace',
            text: 'The analyzer already has a resume file with ' + r.existing_completed +
                ' finished tracks. Replace it with this one (' + r.incoming_completed + ' finished)?'
        };
    }
    if (!r.ok) return { action: 'error', message: r.error ? String(r.error) : 'Unexpected reply from the analyzer.' };
    var message = 'Imported resume file: ' + r.completed + ' finished tracks.';
    var switchTo = null;
    if (r.settings_match === false) {
        message += ' It was written with a different Cross-check setting';
        var has = labels && r.matching_setting && Object.prototype.hasOwnProperty.call(labels, r.matching_setting);
        if (has) {
            switchTo = r.matching_setting;
            message += ', so I switched "Cross-check tempo" to "' + labels[switchTo] + '" so the run resumes from it.';
        } else {
            message += '; with the current settings a run would not resume from it.';
        }
    }
    return { action: 'done', message: message, switchTo: switchTo };
}

function analyzerImportLedger(file, replace) {
    var token = _analyzerToken;
    var second = document.getElementById('an-second');
    if (!second) return;
    var path = '/api/ledger?second_opinion=' + encodeURIComponent(second.value) + (replace ? '&replace=1' : '');
    analyzerSetStatus('an-import-status', 'Importing ' + file.name + '…');
    analyzerUpload(path, file).then(function (r) {
        if (!analyzerUiLive(token)) return;
        var out = analyzerLedgerOutcome(r, analyzerSecondLabels());
        if (out.action === 'confirm_replace') {
            analyzerSetStatus('an-import-status', '');
            if (window.confirm(out.text)) analyzerImportLedger(file, true);
            return;
        }
        if (out.action === 'error') {
            analyzerSetStatus('an-import-status', out.message, true);
            return;
        }
        if (out.switchTo) document.getElementById('an-second').value = out.switchTo;
        analyzerSetStatus('an-import-status', out.message);
        analyzerRefreshFiles(token);
        analyzerPlan();
    });
}

// ---- The result --------------------------------------------------------------------

// Fetches the result, asks, and imports it through Restore from backup's own
// code (restoreParsedBackup in src/backup.js), so it follows the same rules.
function analyzerLoadResult() {
    var token = _analyzerToken;
    var btn = document.getElementById('an-load');
    if (btn) btn.disabled = true;
    function done() {
        var b = document.getElementById('an-load');
        if (b && analyzerUiLive(token)) b.disabled = false;
    }
    fetch(ANALYZER_URL + '/api/result').then(function (r) {
        return r.text().then(function (text) { return { status: r.status, text: text }; });
    }).then(function (res) {
        // Asking about a result the user has walked away from would be a
        // dialog out of nowhere.
        if (!analyzerUiLive(token)) return;
        var raw = analyzerParseJson(res.text);
        if (res.status !== 200) {
            analyzerBanner(raw && raw.error ? String(raw.error) : 'The analyzer has no result to load (HTTP ' + res.status + ').', true);
            return done();
        }
        if (!raw || typeof raw !== 'object') {
            analyzerBanner('The analyzer’s result could not be read.', true);
            return done();
        }
        var n = Array.isArray(raw.track_meta) ? raw.track_meta.length : 0;
        var ok = window.confirm('Load ' + n + ' analysed ' + (n === 1 ? 'track' : 'tracks') +
            ' into the app?\n\nThey are merged the way Restore from backup merges: each replaces this ' +
            'browser’s record for the same track, so edits made here since you sent the collection ' +
            'are overwritten for those tracks. Values the analyzer worked out are shown as estimates.');
        if (!ok) return done();
        // No renderCurrentView() here, unlike Restore from backup: this page
        // shows nothing the restore changed, and redrawing it would drop the
        // connection state and option values.
        return restoreParsedBackup(raw).then(done);
    }).catch(function () {
        if (analyzerUiLive(token)) analyzerBanner('Could not reach the analyzer. Is it still running?', true);
        done();
    });
}

// ---- Saved audio ---------------------------------------------------------------------

function analyzerSizeText(bytes) {
    var mb = (bytes || 0) / (1024 * 1024);
    return mb > 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(1) + ' MB';
}

function analyzerFilesText(n) {
    return n + (n === 1 ? ' file' : ' files');
}

function analyzerAudioText(a) {
    return a && a.files > 0
        ? 'Saved audio: ' + analyzerFilesText(a.files) + ', ' + analyzerSizeText(a.bytes)
        : 'No saved audio.';
}

function analyzerUpdateAudioButton() {
    var btn = document.getElementById('an-audio-delete');
    if (btn) btn.disabled = _analyzerWasRunning || _analyzerAudioBusy || !_analyzerAudio || !(_analyzerAudio.files > 0);
}

function analyzerRefreshAudio(token) {
    return fetch(ANALYZER_URL + '/api/audio')
        .then(function (r) { return r.json(); })
        .then(function (a) {
            if (!analyzerUiLive(token) || !a || a.error) return;
            _analyzerAudio = a;
            var stats = document.getElementById('an-audio-stats');
            stats.textContent = analyzerAudioText(a);
            if (a.path) stats.title = String(a.path);
            analyzerUpdateAudioButton();
        })
        .catch(function () { /* the poller reports a dead analyzer */ });
}

function analyzerDeleteAudio() {
    var token = _analyzerToken;
    var a = _analyzerAudio;
    if (_analyzerAudioBusy || !a || !(a.files > 0)) return;
    if (!window.confirm('Delete ' + a.files + ' saved audio ' + (a.files === 1 ? 'file' : 'files') +
        ' (' + analyzerSizeText(a.bytes) + ')? A later run will download them again.')) return;
    _analyzerAudioBusy = true;
    analyzerUpdateAudioButton();
    analyzerSetStatus('an-audio-status', 'Deleting saved audio…');
    analyzerPost('/api/audio/delete', {}).then(function (res) {
        _analyzerAudioBusy = false;
        if (!analyzerUiLive(token)) return;
        var r = res.body;
        if (r.ok) {
            analyzerSetStatus('an-audio-status', 'Deleted ' + analyzerFilesText(r.deleted_files || 0) +
                ', freed ' + analyzerSizeText(r.freed_bytes) + '.');
        } else if (r.code === 'running') {
            analyzerSetStatus('an-audio-status', 'A run is going. Delete the saved audio once it has finished.', true);
        } else if (r.code === 'unsafe_path') {
            analyzerSetStatus('an-audio-status', 'Nothing was deleted: the audio folder is a link to somewhere else. ' +
                (r.error || ''), true);
        } else {
            analyzerSetStatus('an-audio-status', r.error ? String(r.error) : 'Unexpected reply from the analyzer.', true);
        }
        analyzerRefreshAudio(token);
    });
}

// ---- Progress --------------------------------------------------------------------------

function analyzerRenderState(s) {
    var stats = document.getElementById('an-stats');
    if (!stats || !s || typeof s !== 'object') return;
    var token = _analyzerToken;
    // A run that just finished may have written a result (and a resume file).
    if (_analyzerWasRunning && !s.running) {
        analyzerRefreshFiles(token);
        analyzerRefreshAudio(token);
    }
    _analyzerWasRunning = !!s.running;
    stats.textContent =
        (s.stopping ? 'Stopping after this track…' : (s.activity || 'Idle')) +
        '   ' + (s.done || 0) + ' / ' + (s.total || 0) +
        '   analysed ' + (s.analyzed || 0) + '   failed ' + (s.failed || 0);
    document.getElementById('an-bar').style.width = s.total ? (100 * s.done / s.total) + '%' : '0';
    document.getElementById('an-run').disabled = !!s.running || _analyzerStarting;
    analyzerSendBusy(_analyzerSending);
    var stop = document.getElementById('an-stop');
    stop.hidden = !s.running;
    if (!s.running) stop.disabled = false;
    analyzerUpdateAudioButton();
    if (s.result && s.result !== _analyzerLastResult) {
        _analyzerLastResult = s.result;
        analyzerBanner(String(s.result), analyzerResultIsBad(s.result));
    }
    if (Array.isArray(s.log) && s.log.length !== _analyzerLastLog) {
        _analyzerLastLog = s.log.length;
        var log = document.getElementById('an-log');
        // The last fifty lines: this is a summary view, and the analyzer's own
        // page is there for the full picture.
        log.textContent = s.log.slice(-50).join('\n');
        log.scrollTop = log.scrollHeight;
    }
}

function startAnalyzerPolling(token) {
    stopAnalyzerPolling();
    _analyzerPoll = setInterval(function () {
        // Stop as soon as the view changes, or a closed tab keeps polling a
        // port forever.
        if (!analyzerUiLive(token)) { stopAnalyzerPolling(); return; }
        fetch(ANALYZER_URL + '/api/state')
            .then(function (r) { return r.json(); })
            .then(function (s) {
                _analyzerPollFailures = 0;
                if (analyzerUiLive(token)) analyzerRenderState(s);
            })
            .catch(function () {
                // One dropped poll is not a dead analyzer: wiping the controls
                // (and an open dialog) over a hiccup would lose the user's input.
                if (++_analyzerPollFailures >= 3 && analyzerUiLive(token)) analyzerMissing();
            });
    }, 1000);
}

function stopAnalyzerPolling() {
    if (_analyzerPoll) { clearInterval(_analyzerPoll); _analyzerPoll = null; }
}
