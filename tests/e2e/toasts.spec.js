// Toasts (P6): capped, errors announced assertively, click to dismiss,
// info toasts time out (3 s) before errors (7 s).
const { test, expect } = require('./fixtures');

test('toasts: cap, roles, dismiss, timeouts', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof showToast === 'function');
    const toasts = page.locator('.toast');

    await page.evaluate(() => {
        showToast('hello');
        showToast('bad', 'error');
        for (let i = 0; i < 5; i++) showToast('n' + i);
    });
    await expect(toasts, 'toasts capped at 4 on screen').toHaveCount(4);
    await expect(page.locator('.toast[role="alert"]'), 'oldest (the error) dropped first when over the cap').toHaveCount(0);

    await page.evaluate(() => showToast('err', 'error'));
    await expect(page.locator('.toast-error[role="alert"]'), 'errors use role=alert').toHaveCount(1);
    // Cap again: 'n0' made room for the error.
    await expect(toasts).toHaveCount(4);

    await toasts.first().click();
    await expect(toasts, 'click dismisses').toHaveCount(3);

    // The info toasts expire ~3 s after creation; the error lives 7 s.
    await expect(toasts, 'info toasts leave after 3 s').toHaveCount(1, { timeout: 6_000 });
    await expect(toasts.first(), 'the error stays').toHaveClass(/\btoast-error\b/);
});
