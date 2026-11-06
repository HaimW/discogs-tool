// ESLint for a no-build app: every file in src/ is a classic <script> sharing
// one global scope (see index.html for the load order). So that `no-undef`
// still catches typos, the globals each file declares at the top level are
// collected from the source itself and declared for all of them.
const fs = require('node:fs');
const path = require('node:path');
const js = require('@eslint/js');
const globals = require('globals');

const APP_FILES = ['app.js'];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) APP_FILES.push(p);
    }
})(path.join(__dirname, 'src'));

// `function name`, `async function name`, `var name` at column 0.
const DECL = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm;
const appGlobals = {};
for (const f of APP_FILES) {
    const src = fs.readFileSync(path.resolve(__dirname, f), 'utf8');
    for (const m of src.matchAll(DECL)) appGlobals[m[1] || m[2]] = 'writable';
}

module.exports = [
    {
        ignores: ['node_modules/', 'desktop-analyzer/', 'docs/', '.agentsmith/', '.claude/', 'test-results/', 'playwright-report/', 'blob-report/'],
    },
    js.configs.recommended,
    {
        files: ['app.js', 'src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                ...appGlobals,
                YT: 'readonly',      // YouTube IFrame API
                module: 'readonly',  // the `typeof module` export guards for tests
            },
        },
        rules: {
            // Top-level functions are called from other files and from
            // index.html, which ESLint cannot see; locals are still checked.
            'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }],
            // Each file re-declares nothing in practice; the collected
            // globals above would make this rule fire on every declaration.
            'no-redeclare': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['tests/**/*.js', 'eslint.config.js', 'playwright.config.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },
    {
        // Browser smoke tests: the page.evaluate()/waitForFunction() callbacks
        // run inside the app, so browser globals and the app's own globals
        // (read-only from a test's point of view) are in scope there.
        files: ['tests/e2e/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...Object.fromEntries(Object.keys(appGlobals).map((k) => [k, 'readonly'])),
            },
        },
    },
];
