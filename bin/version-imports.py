#!/usr/bin/env python3
"""Stamp the build version onto every relative module import.

index.html requests /app.js?v=HASH, but a bare `import './server.js'` inside it
resolves to an UNVERSIONED url, which the web server hands out with a long
max-age. The entry point therefore updates on every deploy while its
dependencies stay pinned for as long as the cache lasts, and a fresh app.js
ends up running against stale modules -- a failure that looks exactly like a
deploy that never happened.

Rewriting each specifier to carry the same version makes the whole module
graph cache-bust together.
"""
import re
import sys
from pathlib import Path

dest, version = Path(sys.argv[1]), sys.argv[2]

# `from './x.js'` and `import('./x.js')`, single or double quoted. Specifiers
# that already carry a query are left alone.
SPEC = re.compile(r"""(from\s*|import\s*\(\s*)(['"])(\.{1,2}/[\w./-]+\.js)\2""")

changed = 0
for js in dest.rglob('*.js'):
    src = js.read_text(encoding='utf-8')
    out = SPEC.sub(lambda m: f'{m.group(1)}{m.group(2)}{m.group(3)}?v={version}{m.group(2)}', src)
    if out != src:
        js.write_text(out, encoding='utf-8')
        changed += 1
print(f'  versioned imports in {changed} module(s)')
