// F15 volume control: slider + mute in the now-playing bar drive both YouTube
// players, survive a reload, and the crossfade hands over at the chosen volume.
//
// The real IFrame API is blocked, so the fake window.YT from fake_yt.js is
// installed before the app loads.
const { test, expect } = require('./fixtures');
const { installFakeYT } = require('./fake_yt');

const vol = (page, i) => page.evaluate((n) => window.__ytPlayers[n].volume, i);

async function openApp(page) {
    await page.goto('/');
    await page.waitForFunction(() => window.__ytPlayers && window.__ytPlayers.length === 2 &&
        window.playerReady && window.player2Ready);
}

// Queues two tracks and starts the first, as a click on a track does.
async function playTwoTracks(page) {
    await page.evaluate(() => {
        window.currentQueue = [
            { youtubeId: 'aaaaaaaaaaa', title: 'One', artist: 'A', cover: '' },
            { youtubeId: 'bbbbbbbbbbb', title: 'Two', artist: 'B', cover: '' },
        ];
        window.currentIndex = 0;
        loadFromQueue(0);
        window.__ytPlayers[0].fire(1);
    });
    await expect(page.locator('#now-playing')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installFakeYT);
});

test('volume: the slider sets the player volume, mute toggles it', async ({ page }) => {
    await openApp(page);
    // Ready cleared the stale YouTube-level mute and applied the default.
    expect(await page.evaluate(() => window.__ytPlayers[0].muted)).toBe(false);
    expect(await vol(page, 0)).toBe(100);
    await playTwoTracks(page);

    const slider = page.getByRole('slider', { name: 'Volume' });
    const mute = page.locator('#np-mute');
    await expect(slider).toHaveValue('100');
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    await expect(mute).toHaveAccessibleName('Mute');

    // Keyboard-operable: PageDown steps 10 in Chromium.
    await slider.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('PageDown');
    await expect(slider).toHaveValue('60');
    await expect(slider).toHaveAttribute('aria-valuetext', '60%');
    await expect.poll(() => vol(page, 0)).toBe(60);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => vol(page, 0)).toBe(61);

    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await expect(mute).toHaveAccessibleName('Unmute');
    await expect(slider, 'muting leaves the slider where it was').toHaveValue('61');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Muted (61%)');
    await expect.poll(() => vol(page, 0)).toBe(0);

    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => vol(page, 0)).toBe(61);

    // Moving the slider while muted unmutes.
    await mute.click();
    await expect.poll(() => vol(page, 0)).toBe(0);
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => vol(page, 0)).toBe(60);

    // The time display is still there (M6).
    await expect(page.locator('#np-time')).toBeVisible();
});

test('volume: survives a reload and applies to the new players', async ({ page }) => {
    await openApp(page);
    await playTwoTracks(page);
    const slider = page.getByRole('slider', { name: 'Volume' });
    await slider.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('PageDown');
    await expect(slider).toHaveValue('40');
    await page.locator('#np-mute').click();
    await expect.poll(() => page.evaluate(async () => {
        const v = await dbGet('config', 'player_volume');
        const m = await dbGet('config', 'player_muted');
        return [v && v.value, m && m.value];
    })).toEqual([40, true]);

    await page.reload();
    await page.waitForFunction(() => window.__ytPlayers && window.__ytPlayers.length === 2 &&
        window.playerReady && window.player2Ready);
    await expect(page.getByRole('slider', { name: 'Volume' })).toHaveValue('40');
    await expect(page.locator('#np-mute')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => vol(page, 0), 'muted after reload').toBe(0);

    await page.locator('#np-mute').click();
    await expect.poll(() => vol(page, 0)).toBe(40);
    // The restored track (cued on ready) plays at the remembered volume.
    await page.evaluate(() => window.__ytPlayers[0].fire(1));
    expect(await vol(page, 0)).toBe(40);
});

test('volume: a crossfade fades to the chosen volume and hands over at it', async ({ page }) => {
    await openApp(page);
    await playTwoTracks(page);
    // Crossfade on, 1 s fade.
    await page.locator('#np-cf-toggle').click();
    await page.locator('#np-cf-seconds').fill('1');
    await page.locator('#np-cf-seconds').dispatchEvent('change');
    await expect.poll(() => page.evaluate(() => window.cfSeconds)).toBe(1);

    const slider = page.getByRole('slider', { name: 'Volume' });
    await slider.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('PageDown');
    await expect.poll(() => vol(page, 0)).toBe(50);

    // Player 2 cues the next track, then player 1 reaches the fade window.
    await expect.poll(() => page.evaluate(() => window._cfState)).toBe('preloaded');
    await page.evaluate(() => {
        window.__ytPlayers[1].volumes.length = 0;
        window.__ytPlayers[0].time = 299.5;
    });
    await expect.poll(() => page.evaluate(() => window._cfState), { timeout: 5_000 }).toBe('switching');
    expect(await vol(page, 0), 'player 1 loads the next track silently').toBe(0);
    expect(await vol(page, 1), 'player 2 carries the chosen volume').toBe(50);
    const p2Peak = await page.evaluate(() => Math.max(...window.__ytPlayers[1].volumes));
    expect(p2Peak, 'player 2 never went above the chosen volume').toBe(50);
    expect(await page.evaluate(() => window.__ytPlayers[0].videoId)).toBe('bbbbbbbbbbb');

    // Player 1 starts the next track: the hand-over.
    await page.evaluate(() => window.__ytPlayers[0].fire(1));
    await expect.poll(() => page.evaluate(() => window._cfState)).toBe('idle');
    expect(await vol(page, 0), 'player 1 at the chosen volume, not 100').toBe(50);
    expect(await vol(page, 1)).toBe(0);
    await expect(page.locator('#np-title')).toHaveText('Two');
});
