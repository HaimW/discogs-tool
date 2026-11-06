// P6: empty states on a fresh install, the delayed loading state, and the
// shared error screen with "Try again" (src/view_state.js, src/router.js).
const { test, expect, seedApp, navTo } = require('./fixtures');

// The fixtures fail a test on any console.error. The error screen logs one on
// purpose; this takes out exactly the expected entries (and checks they were
// there), so anything else logged still fails the test.
async function allowExpectedErrors(pageErrors, pattern, count) {
    await expect.poll(() => pageErrors.filter((e) => pattern.test(e)).length,
        { message: 'the expected console.error was logged' }).toBe(count);
    for (const e of pageErrors.filter((x) => pattern.test(x))) pageErrors.splice(pageErrors.indexOf(e), 1);
}

test('fresh install (connected, nothing synced): every view says so and offers the next step', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof saveConfig === 'function');
    await page.evaluate(() => saveConfig('tok', 'me'));
    await page.reload();

    const empty = page.locator('#app .empty-state');
    await expect(empty.locator('.empty-title')).toHaveText('Your collection is empty');
    await expect(empty.locator('[data-on-click="startSync"]')).toBeVisible();

    await navTo(page, 'tracks');
    await expect(empty.locator('.empty-title')).toHaveText('No tracks yet');
    await expect(empty.locator('.empty-subtitle')).toContainText('Sync your Discogs collection');
    await expect(empty.locator('[data-on-click="startSync"]')).toBeVisible();

    await navTo(page, 'wantlist');
    await expect(empty.locator('.empty-title')).toHaveText('Your want list is empty');
    await expect(empty.locator('[data-on-click="startWantListSync"]')).toBeVisible();

    await navTo(page, 'setlists');
    await expect(empty.locator('.empty-title')).toHaveText('No setlists yet');
    await expect(empty.locator('[data-on-click="promptNewSetlist"]')).toBeVisible();
    await empty.locator('[data-on-click="promptNewSetlist"]').click();   // prompt answers "Smoke set"
    await expect(page.locator('.setlist-name-input')).toHaveValue('Smoke set');
    await expect(empty.locator('.empty-title')).toHaveText('This setlist is empty');
    await empty.locator('button', { hasText: 'Browse tracks' }).click();
    await expect.poll(() => page.evaluate(() => _currentView)).toBe('tracks');

    await navTo(page, 'store');
    await expect(empty.locator('.empty-title')).toHaveText('Nothing to serialize yet');
    await expect(empty.locator('[data-on-click="startSync"]')).toBeVisible();
    await expect(page.locator('.store-batches-empty')).toContainText('No batches yet');

    await navTo(page, 'stats');
    await expect(empty.locator('.empty-title')).toHaveText('No collection yet');
    await expect(empty.locator('[data-on-click="startSync"]')).toBeVisible();

    await page.locator('#notif-bell-btn').click();
    await expect(page.locator('.notif-empty')).toContainText('No alerts yet');
    await page.locator('.notif-empty [data-on-click="notifOpenWantList"]').click();
    await expect(page.locator('#notif-panel')).not.toHaveClass(/\bopen\b/);
    await expect.poll(() => page.evaluate(() => _currentView)).toBe('wantlist');
});

test('filters matching nothing, and a BPM filter when no track has a BPM', async ({ page }) => {
    await seedApp(page);
    await page.fill('#search-input', 'no such record');
    await page.press('#search-input', 'Enter');
    await expect(page.locator('.empty-title')).toHaveText('No releases match');
    await page.locator('.empty-state [data-on-click="clearAllFilters"]').click();
    await expect(page.locator('.release-card').first()).toBeVisible();

    await page.evaluate(() => dbClear('track_meta'));
    await navTo(page, 'tracks');
    await page.locator('input.bpm-input').first().fill('100');
    await page.locator('input.bpm-input').first().press('Tab');
    await expect(page.locator('.empty-title')).toHaveText('No tracks have a BPM or key yet');
    await expect(page.locator('.empty-state [data-on-click="navigate"]')).toHaveText('Open the Analyzer');
});

test('a slow view shows the loading state after a short delay, announced, then the view', async ({ page }) => {
    await seedApp(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });

    // A fast view never shows it: watch #app for a loading block appearing.
    await page.evaluate(() => {
        window.__sawLoading = false;
        new MutationObserver(() => {
            if (document.querySelector('#app .view-loading')) window.__sawLoading = true;
        }).observe(document.getElementById('app'), { childList: true, subtree: true });
    });
    await navTo(page, 'setlists');
    await expect(page.locator('.setlist-card').first()).toBeVisible();
    expect(await page.evaluate(() => window.__sawLoading), 'no flash of loading on a fast view').toBe(false);

    // Make every IndexedDB read take 1.5 s. Views call the global by name.
    await page.evaluate(() => {
        const real = dbGetAll;
        window.dbGetAll = (store) => new Promise((r) => setTimeout(r, 1500)).then(() => real(store));
    });
    await navTo(page, 'stats');
    const loading = page.locator('#app .view-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveText('Loading stats…');
    await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#view-status')).toHaveAttribute('role', 'status');
    await expect(page.locator('#view-status')).toHaveText('Loading stats…');
    expect(await loading.locator('.view-loading-spinner').evaluate((el) => getComputedStyle(el).animationName),
        'no spinning with reduced motion').toBe('none');

    await expect(page.locator('.stats-page')).toBeVisible();
    await expect(page.locator('#app')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('#view-status')).toHaveText('');
    await expect(loading).toHaveCount(0);
});

test('a slow older view does not overwrite a newer one', async ({ page }) => {
    await seedApp(page);
    await page.evaluate(() => {
        const real = dbGetAll;
        // Only the want list's reads are slow.
        window.__slowWantsRead = false;
        window.dbGetAll = (store) => (store === 'wants'
            ? new Promise((r) => setTimeout(r, 800)).then(() => real(store))
                .then((rows) => { window.__slowWantsRead = true; return rows; })
            : real(store));
    });
    await page.locator('.nav-link[data-nav="wantlist"]').click();
    await navTo(page, 'setlists');
    await expect(page.locator('.setlist-card').first()).toBeVisible();
    // Past the slow want-list read (its view would draw in the same task).
    await page.waitForFunction(() => window.__slowWantsRead);
    await expect(page.locator('.setlist-card').first()).toBeVisible();
    await expect(page.locator('.wl-grid')).toHaveCount(0);
});

test('a view that fails shows the error screen; Try again draws it', async ({ page, pageErrors }) => {
    await seedApp(page);
    await page.evaluate(() => {
        const real = renderStats;
        let failed = false;
        window.renderStats = function () {
            if (!failed) { failed = true; throw new Error('e2e: stats failed once'); }
            return real.apply(this, arguments);
        };
    });
    await navTo(page, 'stats');
    const alert = page.locator('#app .view-error[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert.locator('.empty-title')).toHaveText('This page could not be shown');
    await expect(alert).toContainText('e2e: stats failed once');
    await allowExpectedErrors(pageErrors, /^console\.error: Could not show the stats view: .*e2e: stats failed once/s, 1);

    await alert.locator('#view-retry-btn').click();
    await expect(page.locator('.stats-page')).toBeVisible();
    await expect(alert).toHaveCount(0);
});

test('no IndexedDB at all: a clear message instead of a dead page', async ({ page, pageErrors }) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    });
    await page.goto('/');
    const alert = page.locator('#app .view-error[role="alert"]');
    await expect(alert.locator('.empty-title')).toHaveText('Your saved data could not be opened');
    await expect(alert).toContainText('IndexedDB');
    await expect(alert.locator('#view-retry-btn')).toBeVisible();
    await allowExpectedErrors(pageErrors, /^console\.error: Could not show the .* view: .*IndexedDB/s, 1);
});
