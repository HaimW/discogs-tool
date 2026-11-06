// ============ Queue reorder bookkeeping (F17) ============
//
// Pure index arithmetic for moving one queue entry, kept apart from the DOM
// and the players so it can be tested on its own (tests/queue_order.test.js).
// `to` is the entry's index once the move is done (as moveSetlistTrack uses
// it), so moving entry 1 to 3 in [a b c d e] gives [a c d b e].

// Whether moving `from` to `to` is a real move inside a queue of `length`.
function queueMoveIsValid(length, from, to) {
    return Number.isInteger(from) && Number.isInteger(to) &&
        from >= 0 && from < length && to >= 0 && to < length && from !== to;
}

// Where the entry now at `index` sits after the move. Every index the player
// keeps (the current track, the crossfade's preloaded track) follows its entry
// this way: the moved entry goes to `to`; the ones it passed shift by one
// towards where it came from; the rest stay.
function queueIndexAfterMove(index, from, to) {
    if (index === from) return to;
    if (from < index && index <= to) return index - 1;
    if (to <= index && index < from) return index + 1;
    return index;
}

// `arr` with the entry at `from` moved to `to` (a new array).
function queueMoved(arr, from, to) {
    var out = arr.slice();
    var item = out.splice(from, 1)[0];
    out.splice(to, 0, item);
    return out;
}

// What a move does to playback, given the crossfade state ('idle' |
// 'preloaded' | 'fading' | 'switching', see src/player.js):
//   ok             - false: refuse the move (the caller says why).
//   currentIndex   - the playing track's new index: it follows the track.
//   preloadedIndex - player 2's track's new index, or -1 for none.
//   repreload      - player 2 has the wrong track cued now: drop it and cue
//                    the new next one.
//
// Fade policy: a fade in progress is never broken. While 'fading', player 2
// is already audible and the hand-over will make its track current, so a
// move is only allowed if that track still comes straight after the current
// one (otherwise the new next track would be skipped, or the one fading in
// would play out of order); anything else is refused until the fade is over —
// a few seconds at most. While 'switching' the current and the preloaded
// index are the same track, both follow it and nothing is cued anew (the hand-
// over cues the next track itself), so any move is fine.
function queueMovePlayback(st, from, to) {
    var cur = st.currentIndex;
    var pre = st.preloadedIndex;
    var newCur = cur >= 0 ? queueIndexAfterMove(cur, from, to) : cur;
    var newPre = pre >= 0 ? queueIndexAfterMove(pre, from, to) : -1;
    var res = { ok: true, currentIndex: newCur, preloadedIndex: newPre, repreload: false };
    if (st.cfState === 'fading') {
        if (newPre !== newCur + 1) res = { ok: false, currentIndex: cur, preloadedIndex: pre, repreload: false };
    } else if (st.cfState === 'preloaded') {
        res.repreload = newPre !== newCur + 1;
    }
    return res;
}

