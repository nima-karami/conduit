#!/usr/bin/env python3
"""compare-page.py: build a blind comparison page for N design directions.

Usage: python3 compare-page.py manifest.json out-folder [--seed N]

manifest.json:
{
  "title": "Needs you: UX round 1",
  "intro": "Optional one-paragraph context for the judge.",
  "moments": ["Triage", "Answering", "Back from Away"],      # same moments for every direction
  "directions": [
    {"id": "d1-queue", "summary": "One-line difference of this direction", "shots": ["a.png", "b.png", "c.png"]},
    ...
  ]
}
Shot paths are relative to the manifest. Output: out-folder/index.html plus
out-folder/img/ with neutral names. Directions are shuffled and shown as
"Direction 1..N"; the judge picks the best per moment and overall, then reveals.
Picks are kept in the viewer's browser only; the judge reports them back.
"""
import json, os, random, shutil, sys, html

def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    manifest_path, out = sys.argv[1], sys.argv[2]
    seed = int(sys.argv[sys.argv.index('--seed') + 1]) if '--seed' in sys.argv else None
    m = json.load(open(manifest_path))
    base = os.path.dirname(os.path.abspath(manifest_path))
    moments, dirs = m['moments'], list(m['directions'])
    for d in dirs:
        if len(d['shots']) != len(moments):
            sys.exit(f"direction {d['id']}: {len(d['shots'])} shots for {len(moments)} moments")
    random.Random(seed).shuffle(dirs)
    os.makedirs(os.path.join(out, 'img'), exist_ok=True)
    data = {"title": m['title'], "intro": m.get('intro', ''), "moments": moments, "dirs": []}
    for n, d in enumerate(dirs, 1):
        shots = []
        for k, s in enumerate(d['shots'], 1):
            ext = os.path.splitext(s)[1] or '.png'
            dst = f"img/m{k}-d{n}{ext}"
            shutil.copy(os.path.join(base, s), os.path.join(out, dst))
            shots.append(dst)
        data["dirs"].append({"label": f"Direction {n}", "id": d['id'], "summary": d.get('summary', ''), "shots": shots})
    page = TEMPLATE.replace('__TITLE__', html.escape(m['title'])).replace('__DATA__', json.dumps(data))
    open(os.path.join(out, 'index.html'), 'w').write(page)
    print(f"wrote {out}/index.html with {len(dirs)} directions x {len(moments)} moments")

TEMPLATE = r'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>__TITLE__</title>
<style>
:root { --bg:#f6f6f4; --surface:#fff; --fg:#1b1c1e; --muted:#64666b; --line:#d9d9d4; --pick:#1f4fd1; --pick-ink:#fff; }
@media (prefers-color-scheme: dark) { :root { --bg:#141517; --surface:#1d1f22; --fg:#ececea; --muted:#a0a3a8; --line:#33363b; --pick:#7d9cff; --pick-ink:#0d1020; color-scheme: dark; } }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px max(16px,env(safe-area-inset-left)) 64px; }
main { max-width:1800px; margin:0 auto; display:grid; gap:40px; }
h1 { font-size:26px; margin:0 0 8px; } h2 { font-size:18px; margin:0; } p { margin:0; color:var(--muted); max-width:80ch; }
.summaries { display:grid; gap:8px; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); }
.sum { background:var(--surface); border:1px solid var(--line); padding:10px 12px; }
.sum b { display:block; } .who { color:var(--pick); font-weight:600; } [hidden] { display:none !important; }
.moment { display:grid; gap:12px; }
.grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(420px,1fr)); }
figure { margin:0; display:grid; gap:6px; min-width:0; }
figure a { display:block; border:1px solid var(--line); background:var(--surface); }
figure img { display:block; width:100%; height:auto; }
figcaption { display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:13px; color:var(--muted); }
button { font:500 13px system-ui; color:var(--fg); background:var(--surface); border:1px solid var(--line); border-radius:6px; padding:5px 10px; cursor:pointer; }
button[aria-pressed="true"] { background:var(--pick); color:var(--pick-ink); border-color:var(--pick); }
button:focus-visible, a:focus-visible { outline:3px solid var(--pick); outline-offset:2px; }
.bar { display:flex; flex-wrap:wrap; gap:12px 20px; align-items:center; border-top:1px solid var(--line); padding-top:20px; }
.primary { background:var(--fg); color:var(--bg); border-color:var(--fg); font-weight:600; padding:9px 14px; }
@media (max-width:900px) { .grid { grid-template-columns:1fr; } }
</style></head><body><main>
<header><h1 id="t"></h1><p id="intro"></p></header>
<section><h2>The directions</h2><div class="summaries" id="sums"></div></section>
<div id="moments" style="display:grid;gap:48px"></div>
<section class="moment"><h2>Overall</h2><div class="grid" id="overall" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))"></div></section>
<div class="bar"><button class="primary" id="reveal" aria-expanded="false">Reveal the directions</button><span id="tally"></span></div>
</main><script>
const D = __DATA__;
const KEY = 'compare:' + D.title;
let picks = {}; try { picks = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(picks)); } catch (e) {} };
let shown = false;
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
document.getElementById('t').textContent = D.title;
document.getElementById('intro').textContent = D.intro || 'Pick the best direction for each moment, then overall. Click a screen to open it full size.';
document.getElementById('sums').innerHTML = D.dirs.map(d => `<div class="sum"><b>${d.label} <span class="who" hidden>· ${esc(d.id)}</span></b>${esc(d.summary)}</div>`).join('');
const pickBtn = (slot, i) => `<button type="button" data-slot="${slot}" data-i="${i}">Best</button>`;
document.getElementById('moments').innerHTML = D.moments.map((m, k) => `
  <section class="moment"><h2>${k + 1}. ${esc(m)}</h2><div class="grid">
  ${D.dirs.map((d, i) => `<figure><a href="${d.shots[k]}" target="_blank" rel="noopener"><img src="${d.shots[k]}" alt="${esc(m)}, ${d.label}" loading="lazy"></a>
    <figcaption><span>${d.label} <span class="who" hidden>· ${esc(d.id)}</span></span>${pickBtn('m' + k, i)}</figcaption></figure>`).join('')}
  </div></section>`).join('');
document.getElementById('overall').innerHTML = D.dirs.map((d, i) => `<div class="sum"><b>${d.label} <span class="who" hidden>· ${esc(d.id)}</span></b>${pickBtn('overall', i)}</div>`).join('');
function paint() {
  document.querySelectorAll('button[data-slot]').forEach(b => b.setAttribute('aria-pressed', String(picks[b.dataset.slot] === +b.dataset.i)));
  const total = D.moments.length + 1, done = Object.keys(picks).length;
  let t = `${done} of ${total} picked`;
  if (shown) { const c = {}; Object.values(picks).forEach(i => c[D.dirs[i].id] = (c[D.dirs[i].id] || 0) + 1);
    t += ' · ' + Object.entries(c).map(([id, n]) => `${id}: ${n}`).join(' · '); }
  document.getElementById('tally').textContent = t;
}
document.addEventListener('click', e => {
  const b = e.target.closest('button[data-slot]'); if (!b) return;
  const s = b.dataset.slot, i = +b.dataset.i;
  if (picks[s] === i) delete picks[s]; else picks[s] = i; save(); paint();
});
document.getElementById('reveal').addEventListener('click', e => {
  shown = !shown; e.currentTarget.setAttribute('aria-expanded', String(shown));
  e.currentTarget.textContent = shown ? 'Hide the directions' : 'Reveal the directions';
  document.querySelectorAll('.who').forEach(el => el.hidden = !shown); paint();
});
paint();
</script></body></html>'''

if __name__ == '__main__':
    main()
