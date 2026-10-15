#!/usr/bin/env python3
"""Bundles src/ into one self-contained page, docs/index.html, which GitHub Pages (or any static host) serves as is."""
import pathlib, subprocess, sys, urllib.parse

root = pathlib.Path(__file__).parent
src = root / 'src'
out = root / 'docs'  # GitHub Pages serves this folder
out.mkdir(exist_ok=True)

JS_ORDER = ['core.js', 'server.js', 'tests.js', 'ui-base.js', 'ui-views.js', 'ui-dev.js', 'ui-boot.js']
js = '\n'.join((src / f).read_text() for f in JS_ORDER)
js = js.replace('</script', '<\\/script').replace('<!--', '<\\!--')
css = (src / 'styles.css').read_text()
logo = ('<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--accent)"/>'
        '<path d="M12.5 7.5h7M13.6 7.5v6.4L8.4 22.6a1.7 1.7 0 0 0 1.5 2.4h12.2a1.7 1.7 0 0 0 1.5-2.4l-5.2-8.7V7.5" fill="none" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        '<path d="M10.6 19.5h10.8" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round"/></svg>')
favicon = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0a6c66"/>'
           '<path d="M12.5 7.5h7M13.6 7.5v6.4L8.4 22.6a1.7 1.7 0 0 0 1.5 2.4h12.2a1.7 1.7 0 0 0 1.5-2.4l-5.2-8.7V7.5M10.6 19.5h10.8" '
           'fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>')
shell = (src / 'shell.html').read_text().replace('%%LOGO%%', logo)

page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>LabPilot</title>
<meta name="description" content="A working multi-tenant cloud-lab platform: UI, REST API, SQLite database, job worker and test suite. Built by Shovan Dutta.">
<meta name="author" content="Shovan Dutta">
<meta name="theme-color" content="#0a6c66">
<meta property="og:title" content="LabPilot">
<meta property="og:description" content="Multi-tenant hands-on cloud labs: launch, provision, validate, tear down. UI, API, database, worker and tests in one page.">
<link rel="icon" href="data:image/svg+xml,{urllib.parse.quote(favicon)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=Schibsted+Grotesk:wght@600;700;800&display=swap">
<style>
:root {{ padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }}
[hidden] {{ display: none !important; }}
img {{ max-width: 100%; }}
{css}
</style>
</head>
<body>
{shell}
<script>
{js}
</script>
</body>
</html>
'''
(out / 'index.html').write_text(page)

(out / '_bundle.js').write_text(js)
r = subprocess.run(['node', '--check', str(out / '_bundle.js')], capture_output=True, text=True)
(out / '_bundle.js').unlink()
if r.returncode:
    print(r.stderr); sys.exit(1)
print(f'ok: docs/index.html {len(page)/1024:.1f} KB')
