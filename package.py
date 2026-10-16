from pathlib import Path
import re
import zipfile

root = Path(__file__).resolve().parent
html = (root / 'dist/index.html').read_text()
html = html.replace('data-storage="server"', 'data-storage="local"')
for name in ['styles.css', 'campaigns.css', 'session.css']:
    css = (root / 'dist' / name).read_text()
    html = html.replace(f'<link rel="stylesheet" href="{name}">', '<style>' + css + '</style>')

sources = []
for name in ['engine.mjs', 'data.mjs', 'session.mjs', 'app.mjs']:
    text = (root / 'dist' / name).read_text()
    text = re.sub(r'^import .*?;\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^export (?=(?:const|(?:async )?function)\b)', '', text, flags=re.MULTILINE)
    sources.append(text)
script = '\n'.join(sources)
assert '</script' not in script.lower()
html = html.replace('<script type="module" src="app.mjs"></script>', '<script type="module">' + script + '</script>')
assert html.count('<script') == html.count('</script>') == 1
assert 'src="app.mjs"' not in html
assert 'href="styles.css"' not in html
assert 'href="campaigns.css"' not in html
(root / 'conversa-demo.html').write_text(html)

with zipfile.ZipFile(root / 'conversa-demo.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob('*')):
        if path.is_file() and path.suffix not in {'.zip', '.sqlite', '.db', '.key', '.pem'} and not any(part.startswith('.') or part in {'node_modules','__pycache__'} for part in path.relative_to(root).parts) and not any(marker in path.name for marker in ['sqlite-', 'credentials', 'service-account']):
            archive.write(path, path.relative_to(root))
print('Demo autónoma y ZIP con código fuente preparados.')
