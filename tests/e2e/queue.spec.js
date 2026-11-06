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

// ---------- L10: every queue change redraws an open panel ----------

const rowTitles = (page) => page.locator(LIST + ' .queue-row .track-title-line').allTextContents();
const currentTitle = (page) => page.locator(LIST + ' .queue-current .track-title-line').textContent();

test('queue: an open panel follows Play next, a setlist, the want list and a track click', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 3, 0);
    await openPanel(page);
    await expect(page.locator(LIST + ' .queue-row')).toHaveCount(3);

    // Harmonic "Play next": inserted after the current track and played.
    await page.evaluate(() => {
        window._suggestions = [{ youtubeId: 'vsuggest001', releaseId: 9, title: 'Suggested', artist: 'S', cover: '' }];
        playNextSuggestion(0);
    });
    await expect(page.locator('#np-title')).toHaveText('Suggested');
    expect(await rowTitles(page)).toEqual(['Track 1', 'Suggested', 'Track 2', 'Track 3']);
    expect(await currentTitle(page)).toBe('Suggested');

    // A setlist's Play all, then one of its rows.
    const slId = 4242;
    await page.evaluate((id) => dbPut('setlists', {
        id, name: 'Set', created_at: '2026-01-01', updated_at: '2026-01-01', notes: '',
        tracks: [{ youtubeId: 'vset0000001', title: 'Set A', artist: 'X' }, { youtubeId: 'vset0000002', title: 'Set B', artist: 'X' }],
    }), slId);
    await page.evaluate((id) => playSetlist(id), slId);
    await expect(page.locator('#np-title')).toHaveText('Set A');
    await expect.poll(() => rowTitles(page)).toEqual(['Set A', 'Set B']);
    expect(await currentTitle(page)).toBe('Set A');
    await page.evaluate((id) => playFromSetlist(id, 1), slId);
    await expect(page.locator('#np-title')).toHaveText('Set B');
    await expect.poll(() => currentTitle(page)).toBe('Set B');

    // Want list: a release's videos.
    await page.evaluate(async () => {
        await dbPut('wants', { id: 500, title: 'Wanted', artist: 'W', video_count: 2 });
        await dbPut('videos', { release_id: 500, youtube_id: 'vwant000001', title: 'Want 1' });
        await dbPut('videos', { release_id: 500, youtube_id: 'vwant000002', title: 'Want 2' });
        wlPlayRelease(500);
    });
    await expect(page.locator('#np-title')).toHaveText(/Want [12]/);
    await expect.poll(async () => (await rowTitles(page)).sort()).toEqual(['Want 1', 'Want 2']);

    // A click on a track row on a page.
    await page.evaluate(() => {
        const box = document.createElement('div');
        box.id = 'e2e-tracks';
        box.innerHTML = '<div class="video-item" data-youtube-id="vclick00001" data-title="Click 1"></div>' +
            '<div class="video-item" data-youtube-id="vclick00002" data-title="Click 2"></div>';
        document.getElementById('app').appendChild(box);
        playTrack(box.children[1]);
    });
    await expect(page.locator('#np-title')).toHaveText('Click 2');
    expect(await rowTitles(page)).toEqual(['Click 1', 'Click 2']);
    expect(await currentTitle(page)).toBe('Click 2');
});

// ---------- F17: reordering the queue ----------

const titles = (page) => page.locator(LIST + ' .queue-row .track-title-line').allTextContents();
const state = (page) => page.evaluate(() => ({
    currentIndex: window.currentIndex,
    current: window.currentQueue[window.currentIndex].title,
    playing: window.__ytPlayers[0].videoId,
    saved: JSON.parse(sessionStorage.getItem('playerState')).queue.map((q) => q.title),
}));
const focused = (page) => page.evaluate(() => {
    const a = document.activeElement;
    const r = a && a.closest('.queue-row');
    return r ? { row: Array.prototype.indexOf.call(r.parentNode.children, r), cls: a.className.replace('btn ', '') } : null;
});

test('queue: dragging a row by its handle reorders the queue; playback, list and panel stay put', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 60, 2);
    await openPanel(page);
    await settle(page);
    const mid = await setScrollTop(page, 600);
    const shown = await visibleRows(page);
    const [a, b] = [shown[1], shown[4]];
    const box = await page.locator('#queue-panel').boundingBox();

    // Drag row a's handle onto the lower half of row b: it lands after b.
    const target = row(page, b);
    const tb = await target.boundingBox();
    await row(page, a).locator('.queue-drag-handle').dragTo(target, { targetPosition: { x: tb.width / 2, y: tb.height - 4 } });
    await expect.poll(() => titles(page).then((t) => t[b])).toBe('Track ' + (a + 1));
    const t = await titles(page);
    expect(t[b - 1]).toBe('Track ' + (b + 1));
    expect(t[a]).toBe('Track ' + (a + 2));
    expect(t).toHaveLength(60);

    // The playing track (row 2, above the move) is unchanged and highlighted.
    const s = await state(page);
    expect(s.current).toBe('Track 3');
    expect(s.currentIndex).toBe(2);
    expect(s.playing).toBe('v0000000003');
    expect(s.saved, 'saved for a reload').toEqual(t);
    expect(await currentRow(page)).toBe(2);
    await expect(page.locator('#np-title')).toHaveText('Track 3');

    await settle(page);
    expect(Math.abs((await scrollTop(page)) - mid), 'the list did not move').toBeLessThanOrEqual(1);
    const after = await page.locator('#queue-panel').boundingBox();
    expect(Math.abs(after.x - box.x) + Math.abs(after.y - box.y), 'the panel did not move').toBeLessThanOrEqual(1);
    await expect(page.locator(LIST + ' .dragging, ' + LIST + ' .drag-over-above, ' + LIST + ' .drag-over-below')).toHaveCount(0);

    // Moving the playing track itself: currentIndex follows it.
    await setScrollTop(page, 0);
    const r5 = await row(page, 5).boundingBox();
    await row(page, 2).locator('.queue-drag-handle').dragTo(row(page, 5), { targetPosition: { x: r5.width / 2, y: r5.height - 4 } });
    await expect.poll(() => currentRow(page)).toBe(5);
    expect((await state(page)).current).toBe('Track 3');
    expect((await state(page)).playing).toBe('v0000000003');
});

test('queue: a drag from the header moves the panel, never a row; a row drag never moves the panel', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 5, 0);
    await openPanel(page);
    const before = await titles(page);
    const title = await page.locator('#queue-panel .queue-title').boundingBox();
    const box = await page.locator('#queue-panel').boundingBox();
    // Header dragged down over the rows and dropped there.
    await page.mouse.move(title.x + 10, title.y + title.height / 2);
    await page.mouse.down();
    await page.mouse.move(title.x - 90, title.y + 120, { steps: 6 });
    await page.mouse.up();
    const moved = await page.locator('#queue-panel').boundingBox();
    expect(Math.abs(moved.x - (box.x - 100))).toBeLessThanOrEqual(2);
    expect(await titles(page)).toEqual(before);

    // A press-and-drag on a row's title (not the handle) does nothing.
    const t = await row(page, 0).locator('.track-title-line').boundingBox();
    await page.mouse.move(t.x + 5, t.y + 5);
    await page.mouse.down();
    await page.mouse.move(t.x + 5, t.y + 140, { steps: 6 });
    await page.mouse.up();
    expect(await titles(page)).toEqual(before);
    const still = await page.locator('#queue-panel').boundingBox();
    expect(Math.abs(still.x - moved.x) + Math.abs(still.y - moved.y)).toBeLessThanOrEqual(1);

    // A handle drag reorders and leaves the panel where it was.
    const r3 = await row(page, 3).boundingBox();
    await row(page, 0).locator('.queue-drag-handle').dragTo(row(page, 3), { targetPosition: { x: r3.width / 2, y: r3.height - 4 } });
    await expect.poll(() => titles(page)).toEqual(['Track 2', 'Track 3', 'Track 4', 'Track 1', 'Track 5']);
    const end = await page.locator('#queue-panel').boundingBox();
    expect(Math.abs(end.x - moved.x) + Math.abs(end.y - moved.y)).toBeLessThanOrEqual(1);
    expect(await currentRow(page), 'the playing track moved with the drag').toBe(3);
});

// Drag events built by hand, for what a real mouse cannot do on demand: a drag
// whose dragend never comes, or a drop carrying someone else's data.
// fireDrag(page, 'dragstart', i) starts a row drag from row i's handle;
// fireDrag(page, 'dragover' | 'drop', i, { lower, types }) fires on row i with
// a DataTransfer holding `types` (default: the queue's own) and returns
// whether the list took it (preventDefault).
const fireDrag = (page, type, i, opts) => page.evaluate(([t, idx, o]) => {
    const list = document.querySelector('#queue-panel .queue-list');
    const r = list.querySelectorAll('.queue-row')[idx];
    const dt = new DataTransfer();
    const types = (o && o.types) || [QUEUE_DRAG_TYPE];
    types.forEach((ty) => dt.setData(ty, 'x'));
    const b = r.getBoundingClientRect();
    const target = t === 'dragstart' ? r.querySelector('.queue-drag-handle') : r;
    const ev = new DragEvent(t, {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: b.left + b.width / 2, clientY: o && o.lower ? b.bottom - 4 : b.top + 4,
    });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
}, [type, i, opts || null]);

test('queue: a drag whose dragend got lost in a redraw cannot move a row on a later foreign drop', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 6, 0);
    await openPanel(page);
    const before = await titles(page);

    // A row drag starts, then the panel is redrawn under it (a track ended)
    // and no dragend ever arrives.
    await fireDrag(page, 'dragstart', 1);
    expect(await page.evaluate(() => !!window._queueDrag)).toBe(true);
    await page.evaluate(() => refreshQueuePanel({ reveal: false }));
    expect(await page.evaluate(() => !!window._queueDrag), 'stale drag left behind').toBe(true);

    // Text dragged in from elsewhere: no drop indicator, no drop, no move.
    expect(await fireDrag(page, 'dragover', 4, { lower: true, types: ['text/plain'] })).toBe(false);
    await expect(page.locator(LIST + ' .drag-over-above, ' + LIST + ' .drag-over-below')).toHaveCount(0);
    expect(await fireDrag(page, 'drop', 4, { lower: true, types: ['text/plain'] })).toBe(false);
    await settle(page);
    expect(await titles(page)).toEqual(before);

    // A new row drag clears the stale one and works as usual.
    await fireDrag(page, 'dragstart', 0);
    expect(await fireDrag(page, 'dragover', 2, { lower: true })).toBe(true);
    expect(await fireDrag(page, 'drop', 2, { lower: true })).toBe(true);
    await expect.poll(() => titles(page).then((t) => t.slice(0, 3))).toEqual(['Track 2', 'Track 3', 'Track 1']);
});

test('queue: after a drag, focus stays on the track that had it, not on its old row', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 6, 0);
    await openPanel(page);
    // Track 3's play button has focus; Track 1 is dragged below Track 4,
    // which moves Track 3 up a row.
    await row(page, 2).locator('.queue-play-btn').focus();
    await fireDrag(page, 'dragstart', 0);
    await fireDrag(page, 'dragover', 3, { lower: true });
    await fireDrag(page, 'drop', 3, { lower: true });
    await expect.poll(() => titles(page).then((t) => t.slice(0, 4))).toEqual(['Track 2', 'Track 3', 'Track 4', 'Track 1']);
    expect(await focused(page)).toEqual({ row: 1, cls: 'queue-play-btn' });
    expect(await page.evaluate(() => document.activeElement.closest('.queue-row').querySelector('.track-title-line').textContent)).toBe('Track 3');
});

test('queue: move buttons and Alt+Up/Down reorder from the keyboard, keep focus and announce the move', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 10, 4);
    await openPanel(page);
    const live = page.locator('#queue-live');

    // Up button on row 6 (Track 7): it moves above the playing Track 5.
    await row(page, 6).locator('.queue-up-btn').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => titles(page).then((t) => t[5])).toBe('Track 7');
    expect(await focused(page)).toEqual({ row: 5, cls: 'queue-up-btn' });
    await expect(live).toHaveText('Moved Track 7 to position 6 of 10');
    await page.keyboard.press('Enter');
    await expect.poll(() => titles(page).then((t) => t[4])).toBe('Track 7');
    expect(await focused(page)).toEqual({ row: 4, cls: 'queue-up-btn' });
    expect(await currentRow(page), 'Track 5 pushed down, still current').toBe(5);
    expect((await state(page)).current).toBe('Track 5');

    // Alt+Down / Alt+Up on whichever row button has focus.
    await row(page, 0).locator('.queue-play-btn').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => titles(page).then((t) => t.slice(0, 3))).toEqual(['Track 2', 'Track 3', 'Track 1']);
    expect(await focused(page)).toEqual({ row: 2, cls: 'queue-play-btn' });
    await expect(live).toHaveText('Moved Track 1 to position 3 of 10');
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => titles(page).then((t) => t[1])).toBe('Track 1');
    expect(await focused(page)).toEqual({ row: 1, cls: 'queue-play-btn' });

    // At the top: nothing moves, focus stays, and it says why.
    await row(page, 0).locator('.queue-up-btn').focus();
    await expect(row(page, 0).locator('.queue-up-btn')).toHaveAttribute('aria-disabled', 'true');
    const before = await titles(page);
    await page.keyboard.press('Enter');
    await expect(live).toHaveText('Track 2 is already first');
    expect(await titles(page)).toEqual(before);
    expect(await focused(page)).toEqual({ row: 0, cls: 'queue-up-btn' });
    await expect(row(page, 9).locator('.queue-down-btn')).toHaveAttribute('aria-disabled', 'true');

    // The buttons are named for screen readers.
    await expect(row(page, 3).getByRole('button', { name: 'Move Track 4 down' })).toHaveCount(1);
});

test('queue: a keyboard move past the edge of the list scrolls just enough to follow it', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 60, 0);
    await openPanel(page);
    await settle(page);
    await setScrollTop(page, 0);
    const shown = await visibleRows(page);
    const lastShown = shown[shown.length - 1];
    await row(page, lastShown).locator('.queue-down-btn').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => focused(page)).toEqual({ row: lastShown + 1, cls: 'queue-down-btn' });
    expect(await rowVisible(page, lastShown + 1)).toBe(true);
    expect(await page.evaluate(() => window.scrollY), 'the page itself does not scroll').toBe(0);
});

test.describe('on a touch screen', () => {
    test.use({ hasTouch: true, viewport: { width: 360, height: 740 } });

    test('queue: the move buttons are finger-sized and the handle is hidden', async ({ page }) => {
        await openApp(page);
        await playQueue(page, 4, 0);
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        await page.locator('#np-queue').tap();
        await expect(page.locator('#queue-panel')).toBeVisible();
        await expect(row(page, 0).locator('.queue-drag-handle')).toBeHidden();
        const up = await row(page, 1).locator('.queue-up-btn').boundingBox();
        expect(up.width).toBeGreaterThanOrEqual(32);
        expect(up.height).toBeGreaterThanOrEqual(24);
        await row(page, 1).locator('.queue-up-btn').tap();
        await expect.poll(() => titles(page).then((t) => t.slice(0, 2))).toEqual(['Track 2', 'Track 1']);
        expect(await currentRow(page)).toBe(1);
    });
});

test('queue: a reorder re-cues the crossfade when the next track changes, and never breaks a fade', async ({ page }) => {
    await openApp(page);
    await playQueue(page, 6, 1);
    // Crossfade on, 30 s fade (the longest), so the fade below lasts.
    await page.locator('#np-cf-toggle').click();
    await page.locator('#np-cf-seconds').fill('30');
    await page.locator('#np-cf-seconds').dispatchEvent('change');
    await expect.poll(() => page.evaluate(() => window._cfState)).toBe('preloaded');
    const cued = () => page.evaluate(() => ({ state: window._cfState, index: window._cfPreloadedIndex, video: window.__ytPlayers[1].videoId }));
    expect(await cued(page)).toEqual({ state: 'preloaded', index: 2, video: 'v0000000003' });
    await openPanel(page);

    // One move that keeps the pair together (Track 5 to the top): the cue
    // stays, its index follows.
    const dropOnto = async (from, to, lower) => {
        const tb = await row(page, to).boundingBox();
        await row(page, from).locator('.queue-drag-handle').dragTo(row(page, to), { targetPosition: { x: tb.width / 2, y: lower ? tb.height - 4 : 4 } });
    };
    await dropOnto(4, 0, false);
    await expect.poll(() => titles(page).then((t) => t[0])).toBe('Track 5');
    expect(await cued(page)).toEqual({ state: 'preloaded', index: 3, video: 'v0000000003' });
    expect(await currentRow(page)).toBe(2);

    // Dropping a track in right after the current one: re-cued.
    await dropOnto(5, 3, false);
    await expect.poll(() => titles(page)).toEqual(['Track 5', 'Track 1', 'Track 2', 'Track 6', 'Track 3', 'Track 4']);
    await expect.poll(() => cued(page)).toEqual({ state: 'preloaded', index: 3, video: 'v0000000006' });

    // Into the fade: player 1 is 20 s from the end of a 30 s fade window.
    await page.evaluate(() => { window.__ytPlayers[0].time = 280; });
    await expect.poll(() => page.evaluate(() => window._cfState), { timeout: 5_000 }).toBe('fading');

    // Something between the two fading tracks: refused, nothing changes.
    const before = await titles(page);
    await row(page, 4).locator('.queue-play-btn').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.locator('.toast')).toContainText('Crossfading');
    expect(await titles(page)).toEqual(before);
    expect(await cued(page)).toEqual({ state: 'fading', index: 3, video: 'v0000000006' });

    // A move that keeps the pair together is fine; the fade carries on.
    await dropOnto(0, 5, true);
    await expect.poll(() => titles(page)).toEqual(['Track 1', 'Track 2', 'Track 6', 'Track 3', 'Track 4', 'Track 5']);
    expect(await cued(page)).toEqual({ state: 'fading', index: 2, video: 'v0000000006' });
    expect(await currentRow(page)).toBe(1);
});
