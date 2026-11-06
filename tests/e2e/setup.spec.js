// First-run setup: the token is checked against (fake) Discogs before saving.
const { test, expect } = require('./fixtures');

test('setup: empty form, rejected token, username mismatch, then connect', async ({ page }) => {
    await page.goto('/');
    const status = page.locator('#setup-status');

    await page.locator('#setup-submit').click();
    await expect(status, 'empty form explains what is missing').toHaveText(/both/i);

    await page.fill('#setup-username', 'realuser');
    await page.fill('#setup-token', 'bad-token');
    await page.locator('#setup-submit').click();
    await expect(page.locator('.setup-status-error')).toBeVisible();
    await expect(status, 'rejected token is reported').toHaveText(/did not accept/);
    expect(await page.evaluate(() => isConfigured()), 'rejected token is not saved').toBe(false);

    await page.fill('#setup-username', 'someone-else');
    await page.fill('#setup-token', 'good-token');
    await page.locator('#setup-submit').click();
    await expect(status, "username mismatch names the token's account").toHaveText(/belongs to/);

    await status.locator('button').click();
    await expect(page.locator('.setup-status-ok')).toBeVisible();
    await expect(status, '"Use RealUser" connects and confirms').toHaveText(/Connected as RealUser/);
    await expect(page.locator('.setup-avatar'), 'avatar shown').toHaveCount(1);
    expect(await page.evaluate(() => getConfig()), "saved with the account's exact username")
        .toMatchObject({ username: 'RealUser', token: 'good-token' });
    await expect.poll(() => page.evaluate(() => _currentView), { message: 'moves on to the collection' })
        .toBe('collection');
});

test.describe('with Discogs unreachable', () => {
    test.use({ discogs: 'down' });

    test('setup: "Save without checking" saves', async ({ page }) => {
        await page.goto('/');
        await page.fill('#setup-username', 'x');
        await page.fill('#setup-token', 'good-token');
        await page.locator('#setup-submit').click();
        await page.locator('[data-on-click="saveSetupUnchecked"]').click();
        await expect.poll(() => page.evaluate(() => isConfigured())).toBe(true);
    });
});
