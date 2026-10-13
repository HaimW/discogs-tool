// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchVideos, playableVideos, vmSeconds, vmVersion } = require('../src/video_match.js');

const ur016 = require('./fixtures/davina-ur016.json');   // A (Club) 7:50, B (Radio) 5:30, 32 videos
const hr1006 = require('./fixtures/davina-hr1006.json'); // A1 (Extended), B1, B2 (Performance Mix), no lengths

const titles = (vs) => vs.map((v) => v.title);
const row = (m, pos) => m.rows.find((r) => r.track.position === pos);

test('UR-016: each side gets the upload that matches its length and version', () => {
    const m = matchVideos(ur016.tracks, ur016.videos, {});
    assert.equal(m.grouped, true);
    assert.equal(row(m, 'A').winner.title, "Davina - Don't You Want It (Club Mix)");
    assert.equal(row(m, 'B').winner.title, "Davina – Don't You Want It (Radio Mix)");
});

test('UR-016: same-length uploads under another name are grouped, not shown as separate tracks', () => {
    const m = matchVideos(ur016.tracks, ur016.videos, {});
    const aDupes = titles(row(m, 'A').dupes);
    // The 7:50 cut is uploaded as "Extended" as often as "Club".
    assert.ok(aDupes.includes("Davina - Don't You Want It (Extended)"));
    assert.ok(aDupes.includes("Davina - Don't You Want It (Club)"));
    assert.ok(titles(row(m, 'B').dupes).includes("Davina - Don't You Want It"));
});

test('UR-016: mixes not on this pressing, DJ mixes and clips go to "other"', () => {
    const m = matchVideos(ur016.tracks, ur016.videos, {});
    const others = titles(m.others);
    for (const t of [
        "Davina - Don't You Want It (Performance Mix)",
        "Davina - Don't You Want It (Lewis Lastella Remix)",
        "Inner City - Good Life mxd 2 Davina - Don't you want it",
        "Davina - Don't You Want It #housemusic #deephouse #soulfulhouse #vinylcollection #vinyl",
        "Davina - Don't You Want It (Overextended Mix)",
    ]) assert.ok(others.includes(t), t);
});

test('every video lands in exactly one place', () => {
    for (const d of [ur016, hr1006]) {
        const m = matchVideos(d.tracks, d.videos, {});
        const placed = [];
        m.rows.forEach((r) => { if (r.winner) placed.push(r.winner); placed.push(...r.dupes); });
        placed.push(...m.others);
        const ids = placed.map((v) => v.youtube_id).sort();
        const want = [...new Set(d.videos.map((v) => v.youtube_id))].sort();
        assert.deepEqual(ids, want);
    }
});

test('HR1006: without track lengths, version names decide', () => {
    const m = matchVideos(hr1006.tracks, hr1006.videos, {});
    assert.match(row(m, 'A1').winner.title, /Extended/);
    assert.match(row(m, 'B2').winner.title, /Performance Mix/);
    assert.ok(titles(m.others).includes("Davina - Don't You Want It (Club Mix)"));
});

test("the user's pick wins, and is not also filed elsewhere", () => {
    const pick = ur016.videos.find((v) => v.title === "Davina - Don't You Want It (Extended)");
    const m = matchVideos(ur016.tracks, ur016.videos, { 0: pick.youtube_id });
    assert.equal(row(m, 'A').winner, pick);
    assert.equal(m.roles[pick.youtube_id], 'winner');
    assert.ok(!row(m, 'A').dupes.includes(pick));
});

test('an override naming a video that no longer exists is ignored', () => {
    const m = matchVideos(ur016.tracks, ur016.videos, { 0: 'gone0000000' });
    assert.equal(row(m, 'A').winner.title, "Davina - Don't You Want It (Club Mix)");
});

test('no grouping when it would not help or cannot be trusted', () => {
    assert.equal(matchVideos([], ur016.videos, {}).grouped, false);
    assert.equal(matchVideos(ur016.tracks, ur016.videos.slice(0, 2), {}).grouped, false);
    const unrelated = [1, 2, 3].map((i) => ({ youtube_id: 'x' + i, title: 'Something Else ' + i, position: i }));
    const m = matchVideos(ur016.tracks, unrelated, {});
    assert.equal(m.grouped, false);
    assert.equal(m.others.length, 3);
});

test('two tracks the titles cannot tell apart are not guessed between', () => {
    const tracks = [
        { position: 'A', title: 'Same Song', duration: '', index: 0 },
        { position: 'B', title: 'Same Song', duration: '', index: 1 },
    ];
    const videos = [1, 2, 3].map((i) => ({ youtube_id: 'v' + i, title: 'Artist - Same Song', position: i }));
    const m = matchVideos(tracks, videos, {});
    assert.equal(m.grouped, false);
});

test('Play All gets one video per track, in tracklist order', () => {
    const vs = playableVideos(ur016.tracks, ur016.videos, {});
    assert.deepEqual(titles(vs), [
        "Davina - Don't You Want It (Club Mix)",
        "Davina – Don't You Want It (Radio Mix)",
    ]);
    // Unmatchable release: everything, as before.
    assert.equal(playableVideos([], ur016.videos, {}).length, ur016.videos.length);
});

test('helpers', () => {
    assert.equal(vmSeconds('7:50'), 470);
    assert.equal(vmSeconds('1:02:03'), 3723);
    assert.equal(vmSeconds(''), null);
    assert.equal(vmSeconds(0), null);
    assert.deepEqual(vmVersion("Don't You Want It (1992) [UR-016]"), []);
    assert.deepEqual(vmVersion("Don't You Want It (Club Mix)"), ['club']);
    assert.deepEqual(vmVersion('Davina Don\'t You Want It Extended'), ['extended']);
});
