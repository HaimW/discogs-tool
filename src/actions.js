// ============ Delegated event actions (P4) ============
//
// Markup built as strings used to carry its behaviour as inline handlers,
// onclick="fn('value')". Every value then had to be escaped twice — once as
// JavaScript, once as HTML — and one miss was stored XSS (C1). Instead, an
// element now names a function and carries its arguments as JSON data:
//
//     '<button' + act('click', 'wlRemove', [w.id, w.artist, w.title]) + '>'
//
// renders  data-on-click="wlRemove" data-args-click="[12,&quot;A&quot;,…]"
// and one listener per event type on `document` calls wlRemove(12, 'A', …)
// with `this` set to the element. Values are only ever HTML-escaped and
// JSON-parsed, never run as code.
//
// Event types: click, change, input, and two keyboard ones, enter and escape
// (a keydown of that key). An element can carry several types at once.
//
// Arguments the element supplies at the time of the event:
var ACT_THIS = { $act: 'this' };        // the element itself
var ACT_PARENT = { $act: 'parent' };    // its parent element
var ACT_VALUE = { $act: 'value' };      // element.value
var ACT_CHECKED = { $act: 'checked' };  // element.checked
var ACT_EVENT = { $act: 'event' };      // the DOM event

var ACT_TYPES = ['click', 'change', 'input', 'enter', 'escape'];

// The attribute text for one action, with a leading space.
function act(type, fnName, args) {
    if (ACT_TYPES.indexOf(type) === -1) throw new Error('act: unknown event type ' + type);
    if (!/^[A-Za-z_$][\w$]*$/.test(fnName)) throw new Error('act: not a function name: ' + fnName);
    return ' data-on-' + type + '="' + fnName + '"' +
        (args && args.length ? ' data-args-' + type + '="' + escHtml(JSON.stringify(args)) + '"' : '');
}

function _actArg(a, el, e) {
    if (a && typeof a === 'object' && typeof a.$act === 'string') {
        if (a.$act === 'this') return el;
        if (a.$act === 'parent') return el.parentElement;
        if (a.$act === 'value') return el.value;
        if (a.$act === 'checked') return el.checked;
        if (a.$act === 'event') return e;
    }
    return a;
}

// Runs every action of `type` from the event's target up, innermost first,
// as inline handlers bubbled; stopPropagation() in one stops the rest.
function _runActions(type, e) {
    var attr = 'data-on-' + type;
    var el = e.target && e.target.closest ? e.target.closest('[' + attr + ']') : null;
    while (el) {
        var name = el.getAttribute(attr);
        var fn = window[name];
        if (typeof fn === 'function') {
            var raw = el.getAttribute('data-args-' + type);
            var args = raw ? JSON.parse(raw) : [];
            fn.apply(el, args.map(function (a) { return _actArg(a, el, e); }));
        } else {
            console.error('No action function named ' + name);
        }
        if (e.cancelBubble) break;
        el = el.parentElement ? el.parentElement.closest('[' + attr + ']') : null;
    }
}

document.addEventListener('click', function (e) { _runActions('click', e); });
document.addEventListener('change', function (e) { _runActions('change', e); });
document.addEventListener('input', function (e) { _runActions('input', e); });
document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') _runActions('enter', e);
    else if (e.key === 'Escape') _runActions('escape', e);
});

if (typeof module !== 'undefined') module.exports = { act: act, _runActions: _runActions };
