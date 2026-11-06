// Background video (P6): the 3.3 MB mp4 loads only after the page has, is
// never fetched when turned off, and the toggle is remembered.
const { test, expect } = require('./fixtures');

const isMp4 = (r) => new URL(r.url()).pathname.endsWith('.mp4');

test('background video loads after page load by default; toggle off is remembered', async ({ page }) => {
    let loaded = false;
    const mp4 = [];
    page.on('load', () => { loaded = true; });
    page.on('request', (r) => { if (isMp4(r)) mp4.push({ afterLoad: loaded }); });

    const firstMp4 = page.waitForRequest(isMp4);
    await page.goto('/');
    await firstMp4;
    expect(mp4.length, 'video requested by default').toBeGreaterThanOrEqual(1);
    expect(mp4[0].afterLoad, 'video requested only after page load').toBe(true);
    await expect(page.locator('.bg-layer'), 'video layer shown').not.toHaveClass(/\bbg-off\b/);

    await page.locator('#bg-toggle-btn').click();
    await expect(page.locator('.bg-layer')).toHaveClass(/\bbg-off\b/);
    expect(await page.evaluate(() => localStorage.getItem('bg-video')), 'turning it off is remembered').toBe('off');
});

test('background video turned off is never downloaded; turning it on loads it', async ({ page }) => {
    const mp4 = [];
    page.on('request', (r) => { if (isMp4(r)) mp4.push(r.url()); });
    await page.addInitScript(() => localStorage.setItem('bg-video', 'off'));

    await page.goto('/'); // resolves on the load event
    // Proving a request does NOT happen needs a wait: 2.5 s outlasts the
    // requestIdleCallback timeout (2 s) the default path schedules after load.
    await page.waitForTimeout(2_500);
    expect(mp4, 'turned off: the video is never downloaded').toEqual([]);
    await expect(page.locator('#bg-video')).not.toHaveAttribute('src', /./);

    const onMp4 = page.waitForRequest(isMp4);
    await page.locator('#bg-toggle-btn').click();
    await onMp4;
    await expect(page.locator('.bg-layer'), 'turning it back on shows it').not.toHaveClass(/\bbg-off\b/);
});
