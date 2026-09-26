/**
 * Text-fit detector: finds text that a user cannot read because it overlaps, spills out of
 * its box, is sliced by a clipping ancestor with no ellipsis, or was squeezed to nothing by a
 * flex sibling. Runs in the page against real layout — `Range.getClientRects()` on text nodes,
 * never element boxes, because an element box says nothing about where its glyphs landed.
 *
 *   const findings = await auditTextFit(page);
 *   await cropFinding(page, findings[0], 'C:/tmp/crop.png');
 *
 * A finding: `{ kind, path, text, rects, union, detail }`, rects in CSS px of the viewport.
 * Heuristic by nature — every finding is a lead to confirm by eye, not a verdict.
 */

/** Surfaces whose text is painted by their own engine or is not the page's to lay out. */
const DEFAULT_IGNORE = [
  '.monaco-editor .view-lines',
  '.monaco-editor .margin',
  '.monaco-editor .minimap',
  '.monaco-editor .overflow-guard > .decorationsOverviewRuler',
  '.monaco-editor .inputarea',
  '.monaco-editor textarea',
  '.monaco-editor .monaco-mouse-cursor-text',
  '.xterm',
  'canvas',
  'script',
  'style',
  'noscript',
  'template',
  'svg text',
  '.sr-only',
  '[aria-hidden="true"] .sr-only',
  '.react-flow__edge-textwrapper',
];

/**
 * In-page body. Serialised into `page.evaluate`, so it must not close over anything.
 * @param {{ root?: string, ignore?: string[], defaults: string[] }} opts
 */
function auditInPage(opts) {
  const root = (opts.root && document.querySelector(opts.root)) || document.body;
  const ignoreSel = [...opts.defaults, ...(opts.ignore || [])].join(',');
  const VW = window.innerWidth;
  const VH = window.innerHeight;
  const TOL = 1;
  const cs = (el) => getComputedStyle(el);

  // Overlays at rest use pointer-events:none (see the hover-obstruction run), which drops them
  // from elementsFromPoint — force everything hit-testable for the duration of the audit.
  const force = document.createElement('style');
  force.textContent = '*,*::before,*::after{pointer-events:auto!important}';
  document.head.appendChild(force);

  const alpha = (color) => {
    if (!color || color === 'transparent') return 0;
    // Chromium serialises color-mix() results as `color(srgb r g b / a)`, not rgba().
    const slash = color.match(/\/\s*([\d.]+)(%?)\s*\)$/);
    if (slash) return Number.parseFloat(slash[1]) / (slash[2] ? 100 : 1);
    const m = color.match(/rgba\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(/[,\s]+/).filter(Boolean);
    return parts.length >= 4 ? Number.parseFloat(parts[3]) : 1;
  };

  const shortPath = (el) => {
    const bits = [];
    let n = el;
    while (n && n !== document.body && bits.length < 4) {
      let s = n.tagName.toLowerCase();
      const cls = [...n.classList].filter((c) => !/^(chamfer|inkbox)/.test(c)).slice(0, 2);
      if (cls.length) s += `.${cls.join('.')}`;
      bits.unshift(s);
      n = n.parentElement;
    }
    return bits.join(' > ');
  };

  const visibleEl = (el) => {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    for (let n = el; n; n = n.parentElement) {
      const s = cs(n);
      if (Number.parseFloat(s.opacity) < 0.05) return false;
      if (n.getAttribute('aria-hidden') === 'true' && n.closest('.sr-only')) return false;
    }
    return true;
  };

  const clipsX = (s) =>
    s.overflowX !== 'visible' || s.contain.includes('paint') || s.clipPath !== 'none';
  const clipsY = (s) =>
    s.overflowY !== 'visible' || s.contain.includes('paint') || s.clipPath !== 'none';
  const scrolls = (s, axis) => {
    const v = axis === 'x' ? s.overflowX : s.overflowY;
    return v === 'auto' || v === 'scroll';
  };
  const paddingBox = (el) => {
    const r = el.getBoundingClientRect();
    // client* are untransformed layout px; under a scale transform (the canvas at zoom) they
    // must be scaled into the viewport px the rects are in.
    const sx = el.offsetWidth ? r.width / el.offsetWidth : 1;
    const sy = el.offsetHeight ? r.height / el.offsetHeight : 1;
    return {
      left: r.left + el.clientLeft * sx,
      top: r.top + el.clientTop * sy,
      right: r.left + (el.clientLeft + el.clientWidth) * sx,
      bottom: r.top + (el.clientTop + el.clientHeight) * sy,
    };
  };
  const hasBoundary = (s) => {
    if (s.display === 'inline' || s.display === 'contents') return false;
    const border =
      ['Top', 'Right', 'Bottom', 'Left'].some(
        (k) =>
          Number.parseFloat(s[`border${k}Width`]) > 0 &&
          s[`border${k}Style`] !== 'none' &&
          alpha(s[`border${k}Color`]) > 0.15,
      ) || false;
    return border || alpha(s.backgroundColor) > 0.15 || s.backgroundImage !== 'none';
  };
  // A surface that legitimately paints over other content: a portal layer, a popup, a sticky
  // header. Text underneath one is occluded, not overlapped.
  const isLayer = (el) => {
    const s = cs(el);
    if (s.position === 'fixed' || s.position === 'sticky') return true;
    const role = el.getAttribute('role') || '';
    if (/dialog|menu|tooltip|listbox|alertdialog/.test(role)) return true;
    const c = typeof el.className === 'string' ? el.className : '';
    return /modal|menu|popover|tooltip|overlay|toast|dropdown|palette|hover|widget|suggest|peek|zone-widget|ctxmenu|backdrop/.test(
      c,
    );
  };
  const opaque = (el) => {
    const s = cs(el);
    return (
      alpha(s.backgroundColor) >= 0.9 ||
      s.backdropFilter !== 'none' ||
      el.tagName === 'IMG' ||
      el.tagName === 'CANVAS' ||
      el.tagName === 'VIDEO' ||
      el.tagName === 'IFRAME' ||
      el.tagName === 'WEBVIEW'
    );
  };
  const inter = (a, b) => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const union = (rs) => ({
    left: Math.min(...rs.map((r) => r.left)),
    top: Math.min(...rs.map((r) => r.top)),
    right: Math.max(...rs.map((r) => r.right)),
    bottom: Math.max(...rs.map((r) => r.bottom)),
  });
  const plain = (r) => ({
    left: Math.round(r.left),
    top: Math.round(r.top),
    right: Math.round(r.right),
    bottom: Math.round(r.bottom),
  });

  // Forcing pointer-events on makes every at-rest overlay hit-testable, transparent and faded
  // ones included; only an opaque painter hides text. A translucent surface (a toast on the panel
  // material) does NOT — text beneath one reads straight through, which is an overlap.
  const covers = (e) => visibleEl(e) && opaque(e);

  /** Is `lower` hidden under something painted between it and `upper` at (x, y)? */
  const occluded = (x, y, upper, lower) => {
    if (x < 0 || y < 0 || x >= VW || y >= VH) return true;
    const stack = document.elementsFromPoint(x, y);
    const iU = stack.findIndex((e) => e === upper || upper.contains(e));
    const iL = stack.findIndex((e) => e === lower || lower.contains(e));
    // Text overflowing its own (shrunk) box is not in the hit stack at all — the very case of a
    // label painted over its neighbour. Then only a foreign opaque layer on top can hide it.
    if (iU < 0 || iL < 0) {
      for (const e of stack) {
        if ([upper, lower].some((t) => e === t || e.contains(t) || t.contains(e))) return false;
        const s = cs(e);
        if (covers(e) && (isLayer(e) || s.position !== 'static' || s.zIndex !== 'auto'))
          return true;
      }
      return false;
    }
    const [top, bot] = iU < iL ? [iU, iL] : [iL, iU];
    const bottomEl = stack[bot];
    for (let i = top; i < bot; i++) {
      const e = stack[i];
      if (e.contains(bottomEl)) continue;
      if (covers(e)) return true;
    }
    return false;
  };

  // ── collect text runs ─────────────────────────────────────────────────────
  const runs = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const text = t.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = t.parentElement;
    if (!el || el.closest(ignoreSel)) continue;
    if (!visibleEl(el)) continue;
    range.selectNodeContents(t);
    const rects = [...range.getClientRects()]
      .filter((r) => r.width > 0.5 && r.height > 0.5)
      .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    if (!rects.length) continue;
    // Whitespace-only runs between words produce slivers; drop rects narrower than a glyph.
    runs.push({ node: t, el, text, rects, u: union(rects) });
  }

  const findings = [];
  const seen = new Set();
  /**
   * Is `el` covered at every sampled point of `rect` by something foreign — a modal backdrop,
   * a popup, an opaque sibling? A defect nobody can see right now is reported on the frame
   * where it is visible, not through the overlay that hides it.
   */
  const buried = (el, rect) => {
    const r = inter(rect, { left: 0, top: 0, right: VW, bottom: VH });
    if (r.right - r.left < 1 || r.bottom - r.top < 1) return true;
    const cy = (r.top + r.bottom) / 2;
    const xs = [r.left + 1, (r.left + r.right) / 2, r.right - 1];
    // Walk the hit stack top-down to the first thing that decides: the text's own element or an
    // ancestor (text paints over its ancestors' backgrounds) means visible; a foreign opaque
    // painter that is its own layer means buried. Overflowing text is never in the stack itself.
    // An in-flow opaque sibling does not bury: inline content paints above in-flow backgrounds.
    return xs.every((x) => {
      for (const e of document.elementsFromPoint(x, cy)) {
        if (e === el || el.contains(e) || e.contains(el)) return false;
        if (!covers(e)) continue;
        const s = cs(e);
        if (isLayer(e) || s.position !== 'static' || s.zIndex !== 'auto') return true;
      }
      return false;
    });
  };
  const push = (f, probe) => {
    const key = f.dedupe ?? `${f.kind}|${f.path}|${f.text}`;
    delete f.dedupe;
    if (seen.has(key)) return;
    if (probe && buried(probe.el, probe.rect)) return;
    seen.add(key);
    findings.push(f);
  };

  /**
   * Does `text-overflow: ellipsis` on `cutter` actually paint an ellipsis for text in `el`?
   * Only on a block container, and only for its own inline content: set on a flex or grid
   * container (or with a flex item between it and the text) it is silently inert, and the text is
   * sliced mid-glyph exactly as if it were not there.
   */
  function ellipsisRenders(cutter, el) {
    const s = cs(cutter);
    if (s.textOverflow !== 'ellipsis') return false;
    if (!/^(block|inline-block|list-item|flow-root|table-cell)$/.test(s.display)) return false;
    for (let n = el; n && n !== cutter; n = n.parentElement) {
      if (cs(n).display !== 'inline') return false;
    }
    return true;
  }

  // ── clipped / spill ───────────────────────────────────────────────────────
  for (const run of runs) {
    const clip = { left: 0, top: 0, right: VW, bottom: VH };
    const u = run.u;
    const h = u.bottom - u.top;
    const vTol = Math.max(2, h * 0.18);
    // The INNERMOST clipper that actually cuts the text, per axis: an ellipsis or a line clamp
    // only excuses the cut when it sits on that element — one further up paints nothing here.
    let cutterX = null;
    let cutterY = null;
    let box = null;
    for (let n = run.el; n && n !== document.documentElement; n = n.parentElement) {
      const s = cs(n);
      if (!box && n !== run.el && hasBoundary(s)) box = n;
      const cx = clipsX(s);
      const cy = clipsY(s);
      if (cx || cy) {
        const pb = paddingBox(n);
        if (cx) {
          clip.left = Math.max(clip.left, pb.left);
          clip.right = Math.min(clip.right, pb.right);
          if (!cutterX && (pb.left - u.left > TOL || u.right - pb.right > TOL)) cutterX = n;
        }
        if (cy) {
          clip.top = Math.max(clip.top, pb.top);
          clip.bottom = Math.min(clip.bottom, pb.bottom);
          if (!cutterY && (pb.top - u.top > vTol || u.bottom - pb.bottom > vTol)) cutterY = n;
        }
      }
      if (s.position === 'fixed') break;
    }
    // The run's own element can be the box (a button, a chip): its text escaping its own border
    // is a spill just the same.
    if (hasBoundary(cs(run.el))) box = run.el;

    const outL = clip.left - u.left;
    const outR = u.right - clip.right;
    const outT = clip.top - u.top;
    const outB = u.bottom - clip.bottom;
    const cutX = !!cutterX;
    const cutY = !!cutterY;
    const firstClipper = cutterX || cutterY;
    const ellipsis = cutterX ? ellipsisRenders(cutterX, run.el) : false;
    const clamp = cutterY
      ? (cs(cutterY).webkitLineClamp || 'none') !== 'none' ||
        [...cutterY.children].some((k) => (cs(k).webkitLineClamp || 'none') !== 'none')
      : false;
    if (firstClipper) {
      const whollyGone =
        u.right <= clip.left ||
        u.left >= clip.right ||
        u.bottom <= clip.top ||
        u.top >= clip.bottom;
      const offscreen = u.right <= 0 || u.left >= VW || u.bottom <= 0 || u.top >= VH;
      // A scroller cutting text on the axis it scrolls is reading order, not loss.
      const inScroller = (() => {
        for (let n = run.el; n && n !== document.documentElement; n = n.parentElement) {
          const s = cs(n);
          const pb = paddingBox(n);
          const sy = scrolls(s, 'y') && n.scrollHeight > n.clientHeight + 1;
          const sx = scrolls(s, 'x') && n.scrollWidth > n.clientWidth + 1;
          if (sy && (u.top < pb.top - 0.5 || u.bottom > pb.bottom + 0.5)) return true;
          if (sx && (u.left < pb.left - 0.5 || u.right > pb.right + 0.5)) return true;
        }
        return false;
      })();
      const truncatedOk = (!cutX || ellipsis) && (!cutY || clamp);
      if (!offscreen && !inScroller && !truncatedOk) {
        const probe = { el: run.el, rect: inter(u, clip) };
        push(
          {
            kind: 'clipped',
            path: shortPath(run.el),
            text: run.text.slice(0, 120),
            rects: run.rects.map(plain),
            union: plain(u),
            detail: {
              clipper: shortPath(firstClipper),
              clip: plain(clip),
              axis: cutX && cutY ? 'xy' : cutX ? 'x' : 'y',
              overflowPx: Math.round(Math.max(outL, outR, outT, outB)),
              whollyGone,
              ellipsis,
              ellipsisDeclaredButInert:
                !!cutterX && !ellipsis && cs(cutterX).textOverflow === 'ellipsis',
              title: run.el.closest('[title]')?.getAttribute('title')?.slice(0, 120) ?? null,
            },
          },
          probe,
        );
      }
    }
    if (box) {
      const bb = box.getBoundingClientRect();
      const out = {
        l: bb.left - u.left,
        r: u.right - bb.right,
        t: bb.top - u.top,
        b: u.bottom - bb.bottom,
      };
      const escX = Math.max(out.l, out.r) > TOL + 1;
      const escY = Math.max(out.t, out.b) > vTol;
      if (escX || escY) {
        // Only the part of the text that is still visible counts as a spill.
        const escaped = [];
        if (out.r > 0)
          escaped.push({ left: bb.right, top: u.top, right: u.right, bottom: u.bottom });
        if (out.l > 0) escaped.push({ left: u.left, top: u.top, right: bb.left, bottom: u.bottom });
        if (out.b > 0)
          escaped.push({ left: u.left, top: bb.bottom, right: u.right, bottom: u.bottom });
        if (out.t > 0) escaped.push({ left: u.left, top: u.top, right: u.right, bottom: bb.top });
        const visible = escaped.some((r) => area(inter(r, clip)) > 4);
        const offscreen = u.right <= 0 || u.left >= VW || u.bottom <= 0 || u.top >= VH;
        if (visible && !offscreen) {
          const probe = { el: run.el, rect: inter(escaped[0], clip) };
          push(
            {
              kind: 'spill',
              path: shortPath(run.el),
              text: run.text.slice(0, 120),
              rects: run.rects.map(plain),
              union: plain(u),
              detail: {
                box: shortPath(box),
                boxRect: plain(bb),
                overflowPx: Math.round(Math.max(out.l, out.r, out.t, out.b)),
              },
            },
            probe,
          );
        }
      }
    }
  }

  // ── overlap: text vs text ─────────────────────────────────────────────────
  const clipOf = (el) => {
    const c = { left: 0, top: 0, right: VW, bottom: VH };
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = cs(n);
      if (clipsX(s) || clipsY(s)) {
        const pb = paddingBox(n);
        if (clipsX(s)) {
          c.left = Math.max(c.left, pb.left);
          c.right = Math.min(c.right, pb.right);
        }
        if (clipsY(s)) {
          c.top = Math.max(c.top, pb.top);
          c.bottom = Math.min(c.bottom, pb.bottom);
        }
      }
    }
    return c;
  };
  const visRects = new Map();
  for (const run of runs) {
    const c = clipOf(run.el);
    visRects.set(
      run,
      run.rects.map((r) => inter(r, c)).filter((r) => r.right - r.left > 1 && r.bottom - r.top > 1),
    );
  }
  const live = runs.filter((r) => visRects.get(r).length);
  // Sort by top for a cheap sweep; overlap needs vertical intersection first.
  live.sort((a, b) => a.u.top - b.u.top);
  for (let i = 0; i < live.length; i++) {
    const A = live[i];
    for (let j = i + 1; j < live.length; j++) {
      const B = live[j];
      if (B.u.top > A.u.bottom) break;
      if (A.el === B.el || A.el.contains(B.el) || B.el.contains(A.el)) continue;
      let hit = null;
      for (const ra of visRects.get(A)) {
        for (const rb of visRects.get(B)) {
          const x = inter(ra, rb);
          const w = x.right - x.left;
          const hh = x.bottom - x.top;
          // Line boxes of adjacent rows touch by a pixel or two by design; demand a real bite.
          if (
            w > TOL &&
            hh > Math.max(TOL + 1, Math.min(ra.bottom - ra.top, rb.bottom - rb.top) * 0.25)
          ) {
            hit = x;
            break;
          }
        }
        if (hit) break;
      }
      if (!hit) continue;
      const cx = (hit.left + hit.right) / 2;
      const cy = (hit.top + hit.bottom) / 2;
      if (occluded(cx, cy, A.el, B.el) || buried(A.el, hit) || buried(B.el, hit)) continue;
      push({
        kind: 'overlap',
        path: shortPath(A.el),
        text: `${A.text.slice(0, 60)}  ⟂  ${B.text.slice(0, 60)}`,
        rects: [...A.rects, ...B.rects].map(plain),
        union: plain(union([A.u, B.u])),
        detail: { other: shortPath(B.el), at: plain(hit) },
        dedupe: `overlap|${shortPath(A.el)}|${shortPath(B.el)}`,
      });
    }
  }

  // ── overlap: text vs icon / control it does not belong to ────────────────
  const glyphs = [
    ...root.querySelectorAll('svg, img, button, [role="button"], .badge, [class*="__badge"]'),
  ].filter((g) => !g.closest(ignoreSel) && !g.parentElement?.closest('svg') && visibleEl(g));
  for (const g of glyphs) {
    const gr = g.getBoundingClientRect();
    if (gr.width < 2 || gr.height < 2 || gr.width > 400 || gr.height > 120) continue;
    const gc = inter(gr, clipOf(g));
    if (area(gc) < 4) continue;
    for (const run of live) {
      if (g.contains(run.el) || run.el.contains(g)) continue;
      // A glyph inside the same control as the text (a chip's icon beside its label) is laid
      // out by that control; only foreign glyphs count.
      const ctl = run.el.closest('button, [role="button"], a, label');
      if (ctl?.contains(g)) continue;
      for (const r of visRects.get(run)) {
        const x = inter(r, gc);
        const w = x.right - x.left;
        const hh = x.bottom - x.top;
        if (w <= TOL + 1 || hh <= Math.max(TOL + 1, (r.bottom - r.top) * 0.3)) continue;
        const cx = (x.left + x.right) / 2;
        const cy = (x.top + x.bottom) / 2;
        if (occluded(cx, cy, run.el, g) || buried(run.el, x)) continue;
        push({
          kind: 'overlap',
          path: shortPath(run.el),
          text: `${run.text.slice(0, 80)}  ⟂  <${g.tagName.toLowerCase()}${g.className && typeof g.className === 'string' ? `.${g.className.split(/\s+/)[0]}` : ''}>`,
          rects: [...run.rects.map(plain), plain(gr)],
          union: plain(union([run.u, gr])),
          detail: { other: shortPath(g), at: plain(x), glyph: true },
          dedupe: `overlap|${shortPath(run.el.parentElement ?? run.el)}|${shortPath(g.closest('button, [role="button"]') ?? g)}`,
        });
        break;
      }
    }
  }

  // ── squeezed flex items ───────────────────────────────────────────────────
  const flexes = [...root.querySelectorAll('*')].filter((el) => {
    if (el.closest(ignoreSel)) return false;
    const s = cs(el);
    return (
      (s.display === 'flex' || s.display === 'inline-flex') &&
      !s.flexDirection.startsWith('column') &&
      el.children.length >= 2
    );
  });
  for (const f of flexes) {
    if (!visibleEl(f)) continue;
    const fr = f.getBoundingClientRect();
    const clips = cs(f).overflowX !== 'visible' || cs(f).overflowY !== 'visible';
    const items = [...f.children].filter((c) => {
      const s = cs(c);
      if (s.position === 'absolute' || s.position === 'fixed' || !visibleEl(c)) return false;
      // An item wrapped onto a line its clipping container cuts off (the wrap-off idiom for a
      // part that yields whole) is not painted, so it is nobody's rival.
      const r = c.getBoundingClientRect();
      return !(clips && (r.top >= fr.bottom || r.bottom <= fr.top));
    });
    const info = items.map((c) => {
      const text = (c.innerText || '').replace(/\s+/g, ' ').trim();
      const fs = Number.parseFloat(cs(c).fontSize) || 12;
      const w = c.getBoundingClientRect().width;
      const need = neededWidth(c);
      return { c, text, w, fs, need, needs: need > c.clientWidth + 1 };
    });
    for (const it of info) {
      if (it.text.length < 5 || !it.needs) continue;
      const chars = it.w / (it.fs * 0.55);
      const shown = it.w / it.need;
      // Two shapes of the same bug: an item crushed to a few characters, or an item showing
      // under half of itself while a sibling beside it shows all of its own text.
      const crushed = chars <= 3.5;
      const halved = shown < 0.5 && it.text.length >= 8;
      if (!crushed && !halved) continue;
      const rival = info.find(
        (o) =>
          o !== it &&
          o.text.length >= 3 &&
          !o.needs &&
          // A sibling of the same kind (two tabs, two chips) is a peer, not a rival.
          !(o.c.classList[0] && o.c.classList[0] === it.c.classList[0]) &&
          (crushed ? o.w > Math.max(it.w * 2, 30) : o.w >= it.w * 0.6),
      );
      if (!rival) continue;
      const r = it.c.getBoundingClientRect();
      if (r.right <= 0 || r.left >= VW || r.bottom <= 0 || r.top >= VH) continue;
      push(
        {
          kind: 'squeezed',
          path: shortPath(it.c),
          text: it.text.slice(0, 120),
          rects: [plain(r), plain(rival.c.getBoundingClientRect())],
          union: plain(union([r, rival.c.getBoundingClientRect()])),
          detail: {
            widthPx: Math.round(it.w),
            neededPx: Math.round(it.need),
            approxChars: Math.round(chars * 10) / 10,
            shownFraction: Math.round(shown * 100) / 100,
            rival: shortPath(rival.c),
            rivalText: rival.text.slice(0, 80),
            rivalWidthPx: Math.round(rival.w),
          },
        },
        { el: f, rect: f.getBoundingClientRect() },
      );
    }
  }
  /** The width an item's content wants: its own, or the widest clipped descendant's overflow. */
  function neededWidth(el) {
    let need = el.scrollWidth;
    for (const d of el.querySelectorAll('*')) {
      if (d.scrollWidth > d.clientWidth + 1 && clipsX(cs(d))) {
        need = Math.max(need, el.clientWidth + (d.scrollWidth - d.clientWidth));
      }
    }
    return need;
  }

  force.remove();
  return findings;
}

/**
 * Audit the page (or a subtree) for text that does not fit.
 * @param {object} page A Playwright page.
 * @param {{ root?: string, ignore?: string[] }} [opts]
 */
export async function auditTextFit(page, { root, ignore } = {}) {
  return page.evaluate(auditInPage, { root, ignore, defaults: DEFAULT_IGNORE });
}

/** The screenshot clip for a rect plus padding, clamped to the viewport. */
async function cropClip(page, rect, pad = 24) {
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const x = Math.max(0, Math.floor(rect.left - pad));
  const y = Math.max(0, Math.floor(rect.top - pad));
  const right = Math.min(vp.w, Math.ceil(rect.right + pad));
  const bottom = Math.min(vp.h, Math.ceil(rect.bottom + pad));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** Crop a screenshot to a finding's union rect (+ padding). Pass `clip` to reuse a stored one. */
export async function cropFinding(page, finding, path, { pad = 24, clip } = {}) {
  const c = clip ?? (await cropClip(page, finding.union, pad));
  await page.screenshot({ path, clip: c, scale: 'css' });
  return c;
}
