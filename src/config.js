// ============ Config Helpers ============

function getConfig() {
    return Promise.all([
        dbGet('config', 'discogs_token'),
        dbGet('config', 'discogs_username')
    ]).then(function (results) {
        return {
            token: results[0] ? results[0].value : '',
            username: results[1] ? results[1].value : ''
        };
    });
}

function saveConfig(token, username) {
    return Promise.all([
        dbPut('config', { key: 'discogs_token', value: token.trim() }),
        dbPut('config', { key: 'discogs_username', value: username.trim() })
    ]);
}

function isConfigured() {
    return getConfig().then(function (c) { return !!(c.token && c.username); });
}
