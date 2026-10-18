from pathlib import Path
import re
import base64
import zipfile

root = Path(__file__).resolve().parent
html = (root / 'dist/index.html').read_text()
html = html.replace('data-storage="server"', 'data-storage="local"')
logo = base64.b64encode((root / 'dist/assets/conversa-logo-transparente.png').read_bytes()).decode('ascii')
html = html.replace('src="/assets/conversa-logo-transparente.png"', 'src="data:image/png;base64,' + logo + '"')
for name in ['styles.css', 'campaigns.css', 'session.css', 'live-panel.css']:
    css = (root / 'dist' / name).read_text()
    html = html.replace(f'<link rel="stylesheet" href="{name}">', '<style>' + css + '</style>')

sources = []
for name in ['engine.mjs', 'data.mjs', 'session.mjs', 'live-panel.mjs', 'notifications.mjs', 'app.mjs']:
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
for legal_page in ['privacidad', 'terminos', 'eliminar-datos']:
    html = html.replace(f'href="/{legal_page}/"', f'href="https://cc.chatgo.ia.bo/{legal_page}/"')
(root / 'conversa-demo.html').write_text(html)

with zipfile.ZipFile(root / 'conversa-demo.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob('*')):
        if path.is_file() and path.suffix not in {'.zip', '.sqlite', '.db', '.key', '.pem'} and not any(part.startswith('.') or part in {'node_modules','__pycache__'} for part in path.relative_to(root).parts) and not any(marker in path.name for marker in ['sqlite-', 'credentials', 'service-account']):
            archive.write(path, path.relative_to(root))
print('Demo autónoma y ZIP con código fuente preparados.')
