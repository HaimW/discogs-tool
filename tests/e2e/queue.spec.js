// The queue panel (docs/PROJECT_PLAN.md L9). Every change to the queue or the
// current track redraws the panel; the list must stay where the user left it
// and a dragged panel must stay where it was dropped. The list only scrolls on
// its own when the panel opens, or when playback moves on by itself (track
// ended, crossfade, unplayable video, Next/Prev) to a row that is out of view.
const { test, expect } = require('./fixtures');
const { installFakeYT } = require('./fake_yt');

const LIST = '#queue-panel .queue-list';

async function openApp(page) {
    await page.goto('/');
    await page.waitForFunction(() => window.__ytPlayers && window.__ytPlayers.length === 2 &&
        window.playerReady && window.player2Ready);
}

// Queues n tracks ("Track 1".."Track n", ids v000000001..) and starts track
// `current` (0-based), as a click on a track does.
async function playQueue(page, n, current) {
    await page.evaluate(([count, cur]) => {
        const q = [];
        for (let i = 1; i <= count; i++) {
            q.push({ youtubeId: 'v' + String(i).padStart(10, '0'), releaseId: i, title: 'Track ' + i, artist: 'A', cover: '' });
        }
        window.currentQueue = q;
        window.currentIndex = cur;
        loadFromQueue(cur);
        window.__ytPlayers[0].fire(1);
    }, [n, current]);
    await expect(page.locator('#np-title')).toHaveText('Track ' + (current + 1));
}

async function openPanel(page) {
    await page.locator('#np-queue').click();
    await expect(page.locator('#queue-panel')).toBeVisible();
}

const scrollTop = (page) => page.evaluate((sel) => document.querySelector(sel).scrollTop, LIST);
const setScrollTop = (page, v) => page.evaluate(([sel, top]) => {
    const l = document.querySelector(sel);
    l.scrollTop = top;
    return l.scrollTop;
}, [LIST, v]);
const scrollToBottom = (page) => page.evaluate((sel) => {
    const l = document.querySelector(sel);
    l.scrollTop = l.scrollHeight;
    return l.scrollTop;
}, LIST);

// Whether row i (0-based) lies wholly inside the list's visible area.
const rowVisible = (page, i) => page.evaluate(([sel, idx]) => {
    const l = document.querySelector(sel);
    const r = l.querySelectorAll('.queue-row')[idx].getBoundingClientRect();
    const b = l.getBoundingClientRect();
    return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
}, [LIST, i]);

// Indexes of the rows wholly inside the list's visible area.
const visibleRows = (page) => page.evaluate((sel) => {
    const l = document.querySelector(sel);
    const b = l.getBoundingClientRect();
    const out = [];
    l.querySelectorAll('.queue-row').forEach((row, i) => {
        const r = row.getBoundingClientRect();
        if (r.top >= b.top && r.bottom <= b.bottom) out.push(i);
    });
    return out;
}, LIST);

const currentRow = (page) => page.evaluate((sel) =>
    Array.prototype.indexOf.call(document.querySelectorAll(sel + ' .queue-row'),
        document.querySelector(sel + ' .queue-current')), LIST);

// A jump back would come from a deferred scroll (the old code scrolled 50 ms
// after drawing). There is no event to wait for when nothing should happen, so
// give any such timer a chance to fire before checking that nothing moved.
const settle = (page) => page.evaluate(() => new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150)))));

const row = (page, i) => page.locator(LIST + ' .queue-row').nth(i);

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installFakeYT);
});

test('queue: opening the panel shows the current track', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 60, 44);
    await openPanel(page);
    await expect(page.locator(LIST + ' .queue-row')).toHaveCount(60);
    expect(await currentRow(page)).toBe(44);
    await expect.poll(() => rowVisible(page, 44)).toBe(true);
    expect(await page.evaluate(() => window.scrollY), 'the page itself does not scroll').toBe(0);
});

test('queue: play and remove on a row leave the list where it is', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 60, 0);
    await openPanel(page);
    await settle(page);

    const mid = await setScrollTop(page, 1200);
    expect(mid).toBeGreaterThan(0);
    const shown = await visibleRows(page);
    expect(shown.length).toBeGreaterThan(3);
    const target = shown[Math.floor(shown.length / 2)];

    await row(page, target).locator('.queue-play-btn').click();
    await expect(page.locator('#np-title')).toHaveText('Track ' + (target + 1));
    expect(await currentRow(page)).toBe(target);
    await settle(page);
    expect(Math.abs((await scrollTop(page)) - mid), 'play: list did not move').toBeLessThanOrEqual(1);

    const victim = shown[1];
    await row(page, victim).locator('.queue-remove-btn').click();
    await expect(page.locator(LIST + ' .queue-row')).toHaveCount(59);
    await settle(page);
    expect(Math.abs((await scrollTop(page)) - mid), 'remove: list did not move').toBeLessThanOrEqual(1);
});

test('queue: a dragged panel stays where it was dropped when it redraws', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 60, 0);
    await openPanel(page);

    const before = await page.locator('#queue-panel').boundingBox();
    const title = await page.locator('#queue-panel .queue-title').boundingBox();
    await page.mouse.move(title.x + 10, title.y + title.height / 2);
    await page.mouse.down();
    await page.mouse.move(title.x - 290, title.y - 30, { steps: 5 });
    await page.mouse.up();
    const dropped = await page.locator('#queue-panel').boundingBox();
    expect(Math.abs(dropped.x - (before.x - 300))).toBeLessThanOrEqual(2);
    expect(Math.abs(dropped.y - (before.y - 40))).toBeLessThanOrEqual(2);

    // Redraw by playing a row, then by playback moving on by itself.
    await row(page, 2).locator('.queue-play-btn').click();
    await expect(page.locator('#np-title')).toHaveText('Track 3');
    let after = await page.locator('#queue-panel').boundingBox();
    expect(Math.abs(after.x - dropped.x), 'x after play').toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - dropped.y), 'y after play').toBeLessThanOrEqual(1);

    await page.evaluate(() => window.__ytPlayers[0].fire(0));
    await expect(page.locator('#np-title')).toHaveText('Track 4');
    after = await page.locator('#queue-panel').boundingBox();
    expect(Math.abs(after.x - dropped.x), 'x after auto-advance').toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - dropped.y), 'y after auto-advance').toBeLessThanOrEqual(1);

    // Still draggable after a redraw, and only the new panel listens.
    const t2 = await page.locator('#queue-panel .queue-title').boundingBox();
    await page.mouse.move(t2.x + 10, t2.y + t2.height / 2);
    await page.mouse.down();
    await page.mouse.move(t2.x + 60, t2.y + t2.height / 2 + 20, { steps: 3 });
    await page.mouse.up();
    const moved = await page.locator('#queue-panel').boundingBox();
    expect(Math.abs(moved.x - (after.x + 50))).toBeLessThanOrEqual(2);
    expect(Math.abs(moved.y - (after.y + 20))).toBeLessThanOrEqual(2);
});

test('queue: playback moving on by itself brings the new track into view only if it is hidden', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 60, 4);
    await openPanel(page);
    await settle(page);
    await setScrollTop(page, 0);
    expect(await rowVisible(page, 5)).toBe(true);

    // Next row already in view: the list stays put.
    await page.evaluate(() => window.__ytPlayers[0].fire(0));
    await expect(page.locator('#np-title')).toHaveText('Track 6');
    await settle(page);
    expect(await scrollTop(page), 'visible next row: no scroll').toBe(0);

    // Track ended, next row out of view: scrolled in.
    await scrollToBottom(page);
    expect(await rowVisible(page, 6)).toBe(false);
    await page.evaluate(() => window.__ytPlayers[0].fire(0));
    await expect(page.locator('#np-title')).toHaveText('Track 7');
    expect(await currentRow(page)).toBe(6);
    await expect.poll(() => rowVisible(page, 6), 'ended').toBe(true);

    // Unplayable video skipped.
    await scrollToBottom(page);
    await page.evaluate(() => window.__ytPlayers[0].events.onError({ data: 150 }));
    await expect(page.locator('#np-title')).toHaveText('Track 8');
    await expect.poll(() => rowVisible(page, 7), 'error skip').toBe(true);

    // Next and Prev buttons.
    await scrollToBottom(page);
    await page.locator('#np-next').click();
    await expect(page.locator('#np-title')).toHaveText('Track 9');
    await expect.poll(() => rowVisible(page, 8), 'next').toBe(true);
    await scrollToBottom(page);
    await page.locator('#np-prev').click();
    await expect(page.locator('#np-title')).toHaveText('Track 8');
    await expect.poll(() => rowVisible(page, 7), 'prev').toBe(true);

    // Those rows were above the visible area; now one below it. The page
    // itself never scrolls.
    await playQueue(page, 60, 50);
    await setScrollTop(page, 0);
    await settle(page);
    await page.evaluate(() => window.__ytPlayers[0].fire(0));
    await expect(page.locator('#np-title')).toHaveText('Track 52');
    await expect.poll(() => rowVisible(page, 51), 'ended, row below').toBe(true);
    expect(await page.evaluate(() => window.scrollY), 'the page itself does not scroll').toBe(0);
});

// ---------- F16: BPM and key beside the row number ----------

const metaCell = (page, i) => row(page, i).locator('.queue-meta');

test('queue: rows show the rounded BPM and the key chip from track_meta, and nothing without data', async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
        const yt = (i) => 'v' + String(i).padStart(10, '0');
        // 1: by release + video. 2: by the item's own metaId. 3: by video alone
        // (the item has no release; the record is on another release).
        // 4: BPM only. 5: key only, written as a musical name. 6: a record with
        // no BPM or key. 7: no record at all.
        await dbPut('track_meta', { id: '1_' + yt(1), release_id: 1, youtube_id: yt(1), bpm: 123.6, key: '8A' });
        await dbPut('track_meta', { id: 'custom-2', release_id: 2, bpm: 99.5, key: '11B', key_source: 'analysis', bpm_source: 'analysis' });
        await dbPut('track_meta', { id: '77_' + yt(3), release_id: 77, bpm: 128, key: '3a' });
        await dbPut('track_meta', { id: '4_' + yt(4), release_id: 4, bpm: 98.2 });
        await dbPut('track_meta', { id: '5_' + yt(5), release_id: 5, key: 'A minor' });
        await dbPut('track_meta', { id: '6_' + yt(6), release_id: 6, rating: 4 });
        const q = [];
        for (let i = 1; i <= 7; i++) q.push({ youtubeId: yt(i), releaseId: i, title: 'Track ' + i, artist: 'A', cover: '' });
        q[1].metaId = 'custom-2';
        q[2].releaseId = null;
        window.currentQueue = q;
        window.currentIndex = 0;
        loadFromQueue(0);
        window.__ytPlayers[0].fire(1);
    });
    await openPanel(page);

    await expect(metaCell(page, 0).locator('.queue-bpm')).toHaveText('124');
    await expect(metaCell(page, 0).locator('.camelot-chip')).toHaveText('8A');
    await expect(metaCell(page, 0).locator('.sr-only')).toHaveText('124 BPM, key 8A');
    await expect(metaCell(page, 0).locator('.queue-meta-vis')).toHaveAttribute('aria-hidden', 'true');
    // No relative key or musical name in this compact chip.
    await expect(metaCell(page, 0).locator('.camelot-rel, .camelot-musical')).toHaveCount(0);

    await expect(metaCell(page, 1).locator('.queue-bpm')).toHaveText('100');
    await expect(metaCell(page, 1).locator('.camelot-chip')).toContainText('11B');
    await expect(metaCell(page, 1).locator('.camelot-chip')).toHaveClass(/camelot-chip-estimated/);

    await expect(metaCell(page, 2).locator('.sr-only')).toHaveText('128 BPM, key 3A');

    await expect(metaCell(page, 3).locator('.sr-only')).toHaveText('98 BPM');
    await expect(metaCell(page, 3).locator('.camelot-chip')).toHaveCount(0);

    await expect(metaCell(page, 4).locator('.sr-only')).toHaveText('key 8A');
    await expect(metaCell(page, 4).locator('.queue-bpm')).toHaveCount(0);

    for (const i of [5, 6]) {
        expect(await metaCell(page, i).innerHTML(), 'row ' + (i + 1) + ' shows nothing').toBe('');
    }
    // Every row keeps the column, so the thumbnails line up (measured from the
    // row number: the current row's 1px border shifts the whole row).
    const xs = await page.evaluate(() => Array.from(document.querySelectorAll('#queue-panel .queue-row'),
        (r) => Math.round(r.querySelector('.track-thumb').getBoundingClientRect().left -
            r.querySelector('.queue-num').getBoundingClientRect().right)));
    expect(new Set(xs).size).toBe(1);
    expect(xs[0]).toBeGreaterThan(30);
});

test('queue: the panel draws before BPM/key arrive, and filling them moves nothing', async ({ page }) => {
    await openApp(page);
    const N = 3000;
    await page.evaluate(async (n) => {
        const yt = (i) => 'v' + String(i).padStart(10, '0');
        const db = await openDB();
        await new Promise((res, rej) => {
            const tx = db.transaction('track_meta', 'readwrite');
            for (let i = 1; i <= n; i += 2) tx.objectStore('track_meta').put({ id: i + '_' + yt(i), release_id: i, bpm: 100 + (i % 40) + 0.4, key: ((i % 12) + 1) + 'A' });
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
        });
        const q = [];
        for (let i = 1; i <= n; i++) q.push({ youtubeId: yt(i), releaseId: i, title: 'Track ' + i, artist: 'A', cover: '' });
        window.currentQueue = q;
        window.currentIndex = 0;
        loadFromQueue(0);
        window.__ytPlayers[0].fire(1);
    }, N);

    // Drawn synchronously, with every row and no values yet.
    const atOnce = await page.evaluate(() => {
        openQueue();
        const rows = document.querySelectorAll('#queue-panel .queue-row');
        return { rows: rows.length, filled: document.querySelectorAll('#queue-panel .queue-meta .queue-bpm').length };
    });
    expect(atOnce).toEqual({ rows: N, filled: 0 });
    await expect(page.locator(LIST + ' .queue-meta .queue-bpm')).toHaveCount(N / 2);

    // A redraw keeps the column from the start; filling it does not move the list.
    const mid = await setScrollTop(page, 20000);
    const heightBefore = await page.evaluate((sel) => document.querySelector(sel).scrollHeight, LIST);
    await row(page, (await visibleRows(page))[2]).locator('.queue-play-btn').click();
    await expect(page.locator(LIST + ' .queue-meta .queue-bpm')).toHaveCount(N / 2);
    await settle(page);
    expect(Math.abs((await scrollTop(page)) - mid)).toBeLessThanOrEqual(1);
    expect(await page.evaluate((sel) => document.querySelector(sel).scrollHeight, LIST)).toBe(heightBefore);
});
