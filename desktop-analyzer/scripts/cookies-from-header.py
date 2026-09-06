#!/usr/bin/env python3
"""Turn a copied `Cookie:` request header into the cookies.txt yt-dlp wants.

Why this exists: under WSL, yt-dlp cannot read the browser's own cookie store —
Windows Chrome, Edge and Brave encrypt theirs against the Windows account, and
the Linux side decrypts none of them. An exported cookies.txt works anywhere,
and the Network tab is the one place a browser will hand you every cookie
including the HttpOnly ones. (`document.cookie` in the console will not: the
session cookies that matter are HttpOnly precisely so scripts cannot read them.)

In Chrome: DevTools (F12) -> **Network** tab (not Console) -> reload
youtube.com -> click the top request to www.youtube.com -> right-click it ->
Copy -> Copy as cURL. Paste the whole thing in; the cookie is pulled out of it.

Copying the `cookie` header directly works too, if you can find it.

Then, keeping it on your own machine:

    ./scripts/cookies-from-header.py < header.txt > youtube-cookies.txt

or paste it interactively:

    ./scripts/cookies-from-header.py
    <paste, then Ctrl-D>

The output is a session credential — it lets anyone holding it act as your
YouTube account. Keep it local, do not commit it, and delete it when the run is
done.
"""
import re
import sys
import time

# Netscape's format has no notion of "session cookie", so everything gets a
# concrete expiry. A year is longer than any run and shorter than forever.
EXPIRY = int(time.time()) + 365 * 24 * 3600
DOMAIN = ".youtube.com"


def extract_cookie_header(raw: str) -> str:
    """Pull the cookie value out of whatever the browser handed over.

    Three shapes reach this, because which one you get depends on how you
    copied it, and the fiddliest to produce by hand is the one people manage
    least reliably:

      - the bare value:            "a=1; b=2"
      - the header line:           "cookie: a=1; b=2"
      - a whole `Copy as cURL`:    curl ... -H \'cookie: a=1; b=2\' ...

    The cURL form is worth supporting outright: right-click the request ->
    Copy -> Copy as cURL is two clicks and always in the menu, where finding
    the header row and its copy option is neither.
    """
    text = raw.strip()

    # A pasted cURL command: find the cookie carried in -H or -b, in either
    # quoting style, and put back any line continuations bash would have eaten.
    if text.lstrip().startswith("curl"):
        flat = text.replace("\\\n", " ").replace("^\n", " ").replace("`\n", " ")
        match = re.search(
            r"""-H\s+(['"])\s*cookie\s*:\s*(?P<h>.*?)\1|-b\s+(['"])(?P<b>.*?)\3""",
            flat,
            re.IGNORECASE | re.DOTALL,
        )
        if match:
            return (match.group("h") or match.group("b") or "").strip()
        return ""

    if text.lower().startswith("cookie:"):
        return text.split(":", 1)[1].strip()
    return text


def main() -> int:
    raw = sys.stdin.read().strip()
    if not raw:
        print("nothing on stdin — paste the cookie header and press Ctrl-D",
              file=sys.stderr)
        return 2

    raw = extract_cookie_header(raw)

    pairs = []
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk or "=" not in chunk:
            continue
        name, value = chunk.split("=", 1)
        name, value = name.strip(), value.strip()
        if name:
            pairs.append((name, value))

    if not pairs:
        print("no cookies found in that input", file=sys.stderr)
        return 1

    out = sys.stdout
    out.write("# Netscape HTTP Cookie File\n")
    out.write("# Written by cookies-from-header.py — treat as a password.\n")
    for name, value in pairs:
        # domain, include-subdomains, path, secure, expiry, name, value
        out.write(f"{DOMAIN}\tTRUE\t/\tTRUE\t{EXPIRY}\t{name}\t{value}\n")

    print(f"wrote {len(pairs)} cookies", file=sys.stderr)
    signed_in = {"SID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"}
    if not any(n in signed_in for n, _ in pairs):
        print("warning: none of the usual signed-in cookies (SID, SAPISID, "
              "__Secure-1PSID) are here — you may have copied the header from "
              "a logged-out tab, which will not help.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
