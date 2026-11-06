// Setlist track table (F18): BPM and key for tracks saved without a metaId,
// columns that line up across rows (including a row with no data), a header
// row that is not part of the drag order, and drag reorder.
const { test, expect, seedApp } = require('./fixtures');

const yt = (i) => 'yt' + String(i).padStart(9, '0');

// seedApp writes track_meta "<i>_yt00000000i" with bpm 120 + (i % 10), key 8A.
async function openSetlist(page, viewport) {
    if (viewport) await page.setViewportSize(viewport);
    await seedApp(page);
    const id = await page.evaluate(async (ids) => {
        await dbPut('track_meta', { id: '4_' + ids[4], release_id: 4, youtube_id: ids[4], bpm: 126.5, key: '10B', energy: 6, rating: 5 });
        return dbPut('setlists', {
            name: 'Aligned', notes: '', created_at: '2026-11-06', updated_at: '2026-11-06',
            tracks: [
                { youtubeId: ids[1], title: 'With metaId', artist: 'A', releaseId: 1, metaId: '1_' + ids[1] },
                { youtubeId: ids[2], title: 'Release and video', artist: 'B', releaseId: 2, metaId: null },
                { youtubeId: ids[3], title: 'Video only', artist: 'C', releaseId: null, metaId: null },
                { youtubeId: 'ytNOTHING00', title: 'No data', artist: 'D', releaseId: 77, metaId: null },
                { youtubeId: ids[4], title: 'Other pressing', artist: 'E', releaseId: 99 },
            ],
        }).then(() => dbGetAll('setlists')).then((all) => all.find((s) => s.name === 'Aligned').id);
    }, [0, 1, 2, 3, 4].map(yt));
    await page.evaluate((sid) => navigate('setlist', { setlistId: sid }), id);
    await expect(page.locator('.setlist-tracklist .setlist-row')).toHaveCount(5);
    return id;
}

const rows = (page) => page.locator('.setlist-tracklist .setlist-row');

test('setlist: tracks without a metaId show BPM and key; empty cells keep their place', async ({ page }) => {
    await openSetlist(page);
    const bpm = rows(page).locator('.sl-c-bpm');
    await expect(bpm.nth(0)).toHaveText('121');
    await expect(bpm.nth(1)).toHaveText('122', { useInnerText: true });
    await expect(bpm.nth(2)).toHaveText('123', { useInnerText: true });
    await expect(bpm.nth(3).locator('.sl-none')).toHaveCount(1);
    await expect(bpm.nth(4)).toHaveText(/126\.5/);
    await expect(rows(page).nth(1).locator('.sl-c-key .camelot-chip')).toContainText('8A');
    await expect(rows(page).nth(2).locator('.sl-c-key .camelot-chip')).toContainText('8A');
    await expect(rows(page).nth(4).locator('.sl-c-key .camelot-chip')).toContainText('10B');
    await expect(rows(page).nth(4).locator('.sl-c-rating')).toContainText('5 of 5');
    await expect(page.locator('.setlist-head')).toContainText('BPM');
    await expect(page.locator('.setlist-head [role="columnheader"]')).toHaveCount(10);
});

for (const width of [1280, 800, 700, 360]) {
    test('setlist: BPM and key columns line up across rows at ' + width + 'px', async ({ page }) => {
        await openSetlist(page, { width, height: 900 });
        const boxes = async (sel) => Promise.all(
            [...Array(5).keys()].map((i) => rows(page).nth(i).locator(sel).boundingBox()),
        );
        for (const sel of ['.sl-c-bpm', '.sl-c-key']) {
            const head = await page.locator('.setlist-head ' + sel).boundingBox();
            const bs = await boxes(sel);
            for (const b of bs) {
                expect(b, sel + ' visible').not.toBeNull();
                expect(Math.abs(b.x - head.x), sel + ' left edge').toBeLessThan(0.5);
                expect(Math.abs(b.x + b.width - (head.x + head.width)), sel + ' right edge').toBeLessThan(0.5);
            }
        }
        // The BPM figures themselves end at the same x (rows with a value).
        const badges = await Promise.all([0, 1, 2, 4].map((i) => rows(page).nth(i).locator('.sl-c-bpm .badge-bpm').boundingBox()));
        for (const b of badges) expect(Math.abs(b.x + b.width - (badges[0].x + badges[0].width))).toBeLessThan(0.5);
        // The list fits its column: no sideways overflow from the table.
        const fit = await page.evaluate(() => {
            const l = document.querySelector('.setlist-tracklist');
            return { sw: l.scrollWidth, cw: l.clientWidth, right: l.getBoundingClientRect().right };
        });
        expect(fit.sw).toBeLessThanOrEqual(fit.cw);
        expect(fit.right).toBeLessThanOrEqual(width);
        // The title keeps a readable width; columns are dropped before it is squeezed.
        if (width > 600) {
            const title = await rows(page).first().locator('.sl-c-title').boundingBox();
            expect(title.width, 'title column width').toBeGreaterThanOrEqual(160);
        }
        // Under 900px the key chip shows the code only.
        await expect(rows(page).first().locator('.sl-c-key .camelot-musical')).toBeVisible({ visible: width > 900 });
        // Under 720px rating and energy go.
        const meta = width > 720 ? 'toBeVisible' : 'toBeHidden';
        await expect(rows(page).first().locator('.sl-c-rating'))[meta]();
        await expect(rows(page).first().locator('.sl-c-energy'))[meta]();
    });
}

test('setlist: drag reorder still works and the header is not part of it', async ({ page }) => {
    const id = await openSetlist(page);
    const target = rows(page).nth(2);
    const tb = await target.boundingBox();
    await rows(page).nth(0).locator('.drag-handle').dragTo(target, { targetPosition: { x: tb.width / 2, y: tb.height - 4 } });
    await expect.poll(
        () => page.evaluate(async (sid) => (await dbGet('setlists', sid)).tracks.map((t) => t.title), id),
        { message: 'first track dropped below the third' },
    ).toEqual(['Release and video', 'Video only', 'With metaId', 'No data', 'Other pressing']);
    await expect(rows(page).nth(2).locator('.track-title-line')).toHaveText('With metaId');
    await expect(rows(page).nth(2).locator('.sl-c-num')).toHaveText('3');
    await expect(rows(page).nth(2).locator('.sl-c-bpm')).toHaveText('121');
    await expect(page.locator('.setlist-head')).not.toHaveAttribute('draggable', 'true');
});
