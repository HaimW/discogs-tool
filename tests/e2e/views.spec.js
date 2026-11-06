// Click-through smoke test of every screen with seeded data and no network
// (originally the hand-run P4 handler-migration check). Fails on any page
// error or console.error (see fixtures.js).
const { test, expect, seedApp, navTo } = require('./fixtures');

test.beforeEach(async ({ page }) => {
    await seedApp(page);
});

test('every top-nav view renders, with no inline event handlers', async ({ page }) => {
    // Taken from the DOM so a newly added view is covered automatically.
    const views = await page.locator('.nav-link[data-nav]').evaluateAll((els) => els.map((e) => e.dataset.nav));
    expect(views).toEqual(expect.arrayContaining(['collection', 'tracks', 'wantlist', 'setlists', 'store', 'backup']));
    for (const view of views) {
        await test.step(view, async () => {
            await navTo(page, view);
            await expect(page.locator('#app')).not.toBeEmpty();
            const inline = await page.evaluate(() => document.querySelectorAll('[onclick],[onchange],[oninput],[onkeydown]').length);
            expect(inline, view + ': elements still carrying inline handlers').toBe(0);
        });
    }
});

test('collection: filter, sort, pager, search, release page, add to setlist', async ({ page }) => {
    await page.locator('.genre-pill[data-on-click="setFilter"]', { hasText: 'House' }).first().click();
    await expect(page.locator('.genre-pill.active', { hasText: 'House' })).toHaveCount(1);
    await page.locator('.genre-pill', { hasText: /^All$/ }).first().click();
    await expect(page.locator('.genre-pill.active').first()).toHaveText('All');

    await page.locator('.sort-option').nth(1).click();
    await expect(page.locator('.sort-option').nth(1)).toHaveClass(/\bactive\b/);

    await page.locator('.page-link', { hasText: /^2$/ }).first().click();
    await expect(page.locator('.page-link.active')).toHaveText(['2']);

    await page.fill('#search-input', '7');
    await page.press('#search-input', 'Enter');
    await expect(page.locator('.btn-clear')).toBeVisible();
    await expect(page.locator('.release-card').first()).toBeVisible();
    await page.locator('.btn-clear').click();
    await expect(page.locator('.btn-clear')).toHaveCount(0);

    await page.locator('.release-card').first().click();
    await expect(page.locator('.back-link')).toBeVisible();

    await page.locator('.meta-btn[data-on-click="toggleTrackMetaEditor"]').first().click();
    const wheelSeg = page.locator('.camelot-seg').nth(3);
    await wheelSeg.click();
    await page.locator('button[data-on-click="toggleTrackMetaEditor"]').first().click();
    await expect(wheelSeg, 'meta editor closes on cancel').toBeHidden();

    await page.locator('.add-btn').first().click();
    await page.locator('.popover-item[data-id]').first().click();
    await expect(page.locator('.popover-item[data-id]')).toHaveCount(0);

    await page.locator('.back-link').click();
    await expect(page.locator('.release-card').first()).toBeVisible();
});

test('tracks: rating and key filters, reset, artist opens release', async ({ page }) => {
    await navTo(page, 'tracks');
    await page.locator('.rating-pill').nth(1).click();
    await expect(page.locator('.rating-pill').nth(1)).toHaveClass(/\bactive\b/);
    await page.selectOption('select[data-on-change="tSetFilter"]', { index: 1 });
    await expect(page.locator('.btn-clear[data-on-click="tClearFilters"]')).toBeVisible();
    await page.locator('.btn-clear[data-on-click="tClearFilters"]').click();
    await expect(page.locator('select[data-on-change="tSetFilter"]').first()).toHaveJSProperty('selectedIndex', 0);
    await page.locator('.t-artist').first().click();
    await expect(page.locator('.back-link')).toBeVisible();
});

test('want list: pager, price panel, dig deeper', async ({ page }) => {
    await navTo(page, 'wantlist');
    await page.locator('.page-link', { hasText: /^2$/ }).first().click();
    await expect(page.locator('.page-link.active')).toHaveText(['2']);
    await page.locator('button[data-on-click="wlOpenPricePanel"]').first().click();
    await page.locator('.wl-dd-btn').first().click();
    await expect(page.locator('#wl-dig-deeper-panel')).toBeVisible();
    await page.locator('button[data-on-click="wlCloseDigDeeper"]').first().click();
    await expect(page.locator('#wl-dig-deeper-panel'), 'dig deeper closes').toBeHidden();
});

test('setlists: open, rename saves on change, export menu', async ({ page }) => {
    await navTo(page, 'setlists');
    await page.locator('.setlist-card').first().click();
    const name = page.locator('.setlist-name-input');
    await name.fill('Friday renamed');
    await name.press('Tab');
    await expect.poll(
        () => page.evaluate(async () => (await dbGetAll('setlists')).map((s) => s.name)),
        { message: 'setlist rename (change action) saves' },
    ).toContain('Friday renamed');

    const menu = page.locator('button[data-on-click="toggleExportMenu"]').first();
    await menu.click();
    await expect(page.locator('.popover-item', { hasText: 'M3U playlist' })).toBeVisible();
    await menu.click();
    await expect(page.locator('.popover-item', { hasText: 'M3U playlist' })).toBeHidden();
});

test('store: status filter, search, new batch via Enter', async ({ page }) => {
    await navTo(page, 'store');
    await page.locator('.genre-pill', { hasText: 'Active' }).first().click();
    await expect(page.locator('.genre-pill.active', { hasText: 'Active' })).toHaveCount(1);
    await page.fill('#store-search-input', 'A-0');
    await page.locator('button[data-on-click="storeNewBatchPrompt"]').click();
    await page.fill('#new-batch-name', 'Smoke batch');
    await page.press('#new-batch-name', 'Enter');
    await expect.poll(
        () => page.evaluate(async () => (await dbGetAll('store_batches')).map((b) => b.name)),
        { message: 'new batch via Enter action is created' },
    ).toContain('Smoke batch');
});

test('backup: export button present', async ({ page }) => {
    await navTo(page, 'backup');
    await expect(page.locator('button[data-on-click="exportFullBackup"]')).toHaveCount(1);
});
