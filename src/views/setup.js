// ============ Setup View ============

function renderSetup() {
    getConfig().then(function (config) {
        var app = document.getElementById('app');
        app.innerHTML =
            '<div class="setup-page"><div class="setup-card">' +
            '<div class="vinyl-icon-huge">&#9898;</div>' +
            '<h1 class="setup-title">Welcome to Vinyl Collection Player</h1>' +
            '<p class="setup-subtitle">Connect your Discogs account to get started</p>' +
            '<div class="setup-form">' +
            '<div class="form-group">' +
            '<label class="form-label" for="username">Discogs Username</label>' +
            '<input type="text" id="setup-username" class="form-input" placeholder="e.g. yafim.sh" value="' + escHtml(config.username) + '">' +
            '</div>' +
            '<div class="form-group">' +
            '<label class="form-label" for="token">Personal Access Token</label>' +
            '<div class="token-input-wrap">' +
            '<input type="password" id="setup-token" class="form-input" placeholder="Paste your token here" value="' + escHtml(config.token) + '" autocomplete="current-password">' +
            '<button type="button" class="btn-show-token" id="show-token-btn"' + act('click', 'toggleTokenVisibility') + ' aria-label="Show token">&#128065;</button>' +
            '</div>' +
            '<p class="form-hint">Generate a token at <a href="https://www.discogs.com/settings/developers" target="_blank" rel="noopener">Discogs Developer Settings</a></p>' +
            '</div>' +
            '<button class="btn btn-primary btn-large btn-full" id="setup-submit"' + act('click', 'submitSetup') + '>Save &amp; Continue</button>' +
            '<div id="setup-status" class="setup-status" role="status" aria-live="polite"></div>' +
            '</div></div></div>';
    });
}

// Checks the token with Discogs before saving it (P6), so a typo shows up
// here instead of as an empty collection later: /oauth/identity names the
// account a token belongs to, and /users/{name} gives its avatar.
async function verifyDiscogsToken(token) {
    var headers = { 'Authorization': 'Discogs token=' + token };
    var r;
    try {
        r = await fetch('https://api.discogs.com/oauth/identity', { headers: headers });
    } catch (err) {
        return { ok: false, reason: 'network' };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'rejected' };
    if (!r.ok) return { ok: false, reason: 'http', status: r.status };
    var identity = await r.json();
    var avatar = null;
    try {
        var u = await fetch('https://api.discogs.com/users/' + encodeURIComponent(identity.username), { headers: headers });
        if (u.ok) avatar = (await u.json()).avatar_url || null;
    } catch (e) {}
    return { ok: true, username: identity.username, avatar: avatar };
}

function _setupStatus(html, kind) {
    var el = document.getElementById('setup-status');
    if (!el) return;
    el.className = 'setup-status' + (kind ? ' setup-status-' + kind : '');
    el.innerHTML = html;
}

function _setupBusy(isBusy) {
    var btn = document.getElementById('setup-submit');
    if (!btn) return;
    btn.disabled = isBusy;
    btn.textContent = isBusy ? 'Checking with Discogs…' : 'Save & Continue';
}

async function submitSetup() {
    var token = document.getElementById('setup-token').value.trim();
    var username = document.getElementById('setup-username').value.trim();
    if (!token || !username) {
        _setupStatus('Enter both your Discogs username and your token.', 'error');
        return;
    }
    _setupBusy(true);
    _setupStatus('');
    var check = await verifyDiscogsToken(token);
    _setupBusy(false);

    if (!check.ok) {
        if (check.reason === 'rejected') {
            _setupStatus('Discogs did not accept this token. Copy it again from Discogs Developer Settings; a new token replaces the old one.', 'error');
        } else {
            // Discogs unreachable: let the person save anyway rather than block them.
            _setupStatus('Could not reach Discogs to check the token' +
                (check.status ? ' (HTTP ' + check.status + ')' : '') + '. ' +
                '<button class="btn btn-sm"' + act('click', 'saveSetupUnchecked') + '>Save without checking</button>', 'error');
        }
        return;
    }
    if (check.username.toLowerCase() !== username.toLowerCase()) {
        _setupStatus('This token belongs to <strong>' + escHtml(check.username) + '</strong>, not ' + escHtml(username) + '. ' +
            '<button class="btn btn-sm btn-primary"' + act('click', 'useSetupIdentity', [check.username]) + '>Use ' + escHtml(check.username) + '</button>', 'error');
        return;
    }
    await saveConfig(token, check.username);
    _setupStatus((check.avatar ? '<img class="setup-avatar" src="' + escHtml(check.avatar) + '" alt="" referrerpolicy="no-referrer">' : '') +
        '<span>Connected as <strong>' + escHtml(check.username) + '</strong></span>', 'ok');
    setTimeout(function () { navigate('collection'); }, 1200);
}

// The token's own account, chosen after a username mismatch.
function useSetupIdentity(name) {
    document.getElementById('setup-username').value = name;
    submitSetup();
}

function saveSetupUnchecked() {
    var token = document.getElementById('setup-token').value.trim();
    var username = document.getElementById('setup-username').value.trim();
    if (!token || !username) return;
    saveConfig(token, username).then(function () { navigate('collection'); });
}

function toggleTokenVisibility() {
    var input = document.getElementById('setup-token');
    var btn = document.getElementById('show-token-btn');
    if (!input) return;
    if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈'; // see-no-evil as "hide" indicator
        btn.setAttribute('aria-label', 'Hide token');
    } else {
        input.type = 'password';
        btn.textContent = '👁'; // eye
        btn.setAttribute('aria-label', 'Show token');
    }
}

