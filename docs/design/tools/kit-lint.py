#!/usr/bin/env python3
"""kit-lint.py: fail any UX-round screen that styles itself instead of using the kit.

Usage: python3 kit-lint.py [--frame frame.html] screen-1.html [screen-2.html ...]
With --frame, every block the frame marks as locked
(<!-- wf-locked:NAME --> ... <!-- /wf-locked:NAME -->) must appear unchanged in each screen.
Exit 0 if all pass, 1 with a list of violations otherwise.

Allowed: wireframe.css (and frame.html's own includes), classes starting with
"wf-" or "is-", ids, and inline styles that only set layout.
Not allowed: <style>, other stylesheets, fonts, <img>/<svg>/<canvas>/<video>,
non-kit classes, inline styles that set colour, type, borders, radius, shadow.
"""
import re, sys
from html.parser import HTMLParser

LAYOUT = {
    'display', 'position', 'top', 'right', 'bottom', 'left', 'inset', 'z-index',
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'grid-area',
    'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
    'align-items', 'align-self', 'justify-content', 'justify-self', 'gap', 'row-gap', 'column-gap',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'overflow', 'overflow-x', 'overflow-y', 'white-space',
}
BANNED_TAGS = {'style', 'img', 'svg', 'canvas', 'video', 'picture', 'font'}

class Lint(HTMLParser):
    def __init__(self):
        super().__init__(); self.errors = []
    def err(self, msg):
        self.errors.append(f"line {self.getpos()[0]}: {msg}")
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in BANNED_TAGS:
            self.err(f"<{tag}> is not allowed in a UX round (use the kit; images are .wf-img boxes)")
        if tag == 'link' and 'stylesheet' in (a.get('rel') or ''):
            if not (a.get('href') or '').endswith('wireframe.css'):
                self.err(f"stylesheet {a.get('href')} is not allowed; only wireframe.css")
        for c in (a.get('class') or '').split():
            if not (c == 'wf' or c.startswith('wf-') or c.startswith('is-')):
                self.err(f"class '{c}' is not a kit class")
        style = a.get('style')
        if style:
            for decl in filter(None, (d.strip() for d in style.split(';'))):
                prop = decl.split(':', 1)[0].strip().lower()
                if prop not in LAYOUT:
                    self.err(f"inline style '{prop}' is not layout")

LOCK = re.compile(r'<!-- wf-locked:([\w-]+) -->(.*?)<!-- /wf-locked:\1 -->', re.S)
norm = lambda t: re.sub(r'\s+', ' ', t).strip()

def main():
    args = sys.argv[1:]
    frame = {}
    if '--frame' in args:
        i = args.index('--frame'); fpath = args[i + 1]; del args[i:i + 2]
        frame = {n: norm(b) for n, b in LOCK.findall(open(fpath, encoding='utf-8').read())}
    files = args
    if not files:
        sys.exit(__doc__)
    bad = 0
    for f in files:
        text = open(f, encoding='utf-8').read()
        l = Lint(); l.feed(text)
        got = {n: norm(b) for n, b in LOCK.findall(text)}
        for n, b in frame.items():
            if n not in got: l.errors.append(f"locked block '{n}' from the frame is missing")
            elif got[n] != b: l.errors.append(f"locked block '{n}' was changed; only the free regions may change")
        if l.errors:
            bad += 1
            print(f"FAIL {f}"); [print("  " + e) for e in l.errors[:30]]
        else:
            print(f"ok   {f}")
    sys.exit(1 if bad else 0)

if __name__ == '__main__':
    main()
