#!/usr/bin/env python3
"""Turn a copied `Cookie:` request header into the cookies.txt yt-dlp wants.

Why this exists: under WSL, yt-dlp cannot read the browser's own cookie store —
Windows Chrome, Edge and Brave encrypt theirs against the Windows account, and
the Linux side decrypts none of them. An exported cookies.txt works anywhere,
and the Network tab is the one place a browser will hand you every cookie
including the HttpOnly ones. (`document.cookie` in the console will not: the
session cookies that matter are HttpOnly precisely so scripts cannot read them.)

In Chrome: DevTools (F12) -> Network -> reload youtube.com -> click any request
to www.youtube.com -> Headers -> Request Headers -> right-click `cookie` ->
Copy value.

Then, keeping it on your own machine:

    ./scripts/cookies-from-header.py < header.txt > youtube-cookies.txt

or paste it interactively:

    ./scripts/cookies-from-header.py
    <paste, then Ctrl-D>

The output is a session credential — it lets anyone holding it act as your
YouTube account. Keep it local, do not commit it, and delete it when the run is
done.
"""
import sys
import time

# Netscape's format has no notion of "session cookie", so everything gets a
# concrete expiry. A year is longer than any run and shorter than forever.
EXPIRY = int(time.time()) + 365 * 24 * 3600
DOMAIN = ".youtube.com"


def main() -> int:
    raw = sys.stdin.read().strip()
    if not raw:
        print("nothing on stdin — paste the cookie header and press Ctrl-D",
              file=sys.stderr)
        return 2

    # Tolerate the whole "cookie: a=1; b=2" line as well as just the value,
    # because which one you get depends on how you copied it.
    if raw.lower().startswith("cookie:"):
        raw = raw.split(":", 1)[1]

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
