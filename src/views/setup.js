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
            '<button type="button" class="btn-show-token" id="show-token-btn" onclick="toggleTokenVisibility()" aria-label="Show token">&#128065;</button>' +
            '</div>' +
            '<p class="form-hint">Generate a token at <a href="https://www.discogs.com/settings/developers" target="_blank" rel="noopener">Discogs Developer Settings</a></p>' +
            '</div>' +
            '<button class="btn btn-primary btn-large btn-full" onclick="submitSetup()">Save &amp; Continue</button>' +
            '</div></div></div>';
    });
}

function submitSetup() {
    var token = document.getElementById('setup-token').value.trim();
    var username = document.getElementById('setup-username').value.trim();
    if (!token || !username) { alert('Both fields are required.'); return; }
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

