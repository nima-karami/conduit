/**
 * Terminal fonts are local, load once at boot before the first terminal, never block a session,
 * and a late face re-measures and re-rasterises every terminal (spec 2026-11-02
 * sidebar-agent-tree §8, AC9; plan S4 / T4.4 "runtime symbol/atlas proof in G4").
 *
 *  1. Boot gate: faces held 1.2 s (< BOOT_FONT_TIMEOUT_MS) — at the first terminal's construction
 *     the selected mono 400/700 and UI 400/700 faces are already loaded, and nothing timed out.
 *     Offline: every font the page used is a local file; no http(s) font/stylesheet request, no
 *     CSP violation, no remote @font-face/@import, CSP font-src is 'self' only.
 *  2. Rejected load: the mono faces' requests are cancelled — the failure is logged and the
 *     sessions still mount and take input.
 *  3. Timed-out boot + late face: faces held 8 s — the timeout is logged, both terminals mount
 *     before the face, and when it lands BOTH get public clearTextureAtlas, then measure their
 *     cells in the real face.
 *  4. Glyphs ✔❯⚠⏺⎿● in the terminal's own stack: which face renders each (Chromium's platform
 *     font report), that canvas — what the WebGL atlas rasterises with — draws the same face,
 *     monochrome (never a colour-emoji face), and the mono-width ones fit one cell.
 *  5. Font change: the new family is loaded before any terminal's fontFamily is set.
 *  6. TERM is still xterm-256color, and the PTY is the xterm's size.
 */
import {
  assert,
  assertFontsHeldBack,
  holdBackLocalFonts,
  logicalLines,
  measureCellWidth,
  openSession,
  probeTerminalSize,
  REPO,
  runScenario,
  TERMINAL_FACE_FILE,
  tapBridge,
  tapLocalFontRequests,
  terminalFace,
  typeLine,
  waitForOutput,
} from './harness.mjs';

/** webview/terminal-fonts.ts BOOT_FONT_TIMEOUT_MS. */
const BOOT_FONT_TIMEOUT_MS = 3000;
const GATE_HOLD_MS = 1200;
const LATE_HOLD_MS = 8000;
const CHANGE_HOLD_MS = 1500;
/** UI font ids → the family fonts.css declares (webview/themes.ts UI_FONTS, bundled ones). */
const UI_FAMILY = {
  hanken: 'Hanken Grotesk',
  inter: 'Inter',
  plexsans: 'IBM Plex Sans',
  figtree: 'Figtree',
  chakra: 'Chakra Petch',
};
const GLYPHS = ['✔', '❯', '⚠', '⏺', '⎿', '●'];

/**
 * Instrument every terminal the app builds (window.__terms is the app's opt-in test seam):
 * snapshot document.fonts at construction, count public clearTextureAtlas calls, and snapshot
 * document.fonts whenever its fontFamily option actually changes.
 */
function instrumentTerminals() {
  const snap = () =>
    [...document.fonts].map((f) => ({
      family: f.family.replace(/^["']|["']$/g, ''),
      weight: f.weight,
      status: f.status,
    }));
  const ev = { mounts: {}, first: null, atlas: {}, sets: [], csp: [] };
  window.__fontEv = ev;
  document.addEventListener('securitypolicyviolation', (e) =>
    ev.csp.push({ directive: e.effectiveDirective || e.violatedDirective, uri: e.blockedURI }),
  );
  window.__terms = new Proxy(
    {},
    {
      set(target, id, term) {
        const mount = { at: performance.now(), faces: snap() };
        ev.mounts[id] = mount;
        ev.first ??= { id, ...mount };
        ev.atlas[id] = 0;
        const clear = term.clearTextureAtlas.bind(term);
        term.clearTextureAtlas = () => {
          ev.atlas[id]++;
          return clear();
        };
        let p = term;
        let desc = Object.getOwnPropertyDescriptor(p, 'options');
        while (p && !desc) {
          p = Object.getPrototypeOf(p);
          desc = p ? Object.getOwnPropertyDescriptor(p, 'options') : undefined;
        }
        if (desc?.get) {
          const real = desc.get.call(term);
          const proxied = new Proxy(real, {
            set(t, k, v) {
              if (k === 'fontFamily' && v !== t.fontFamily) {
                ev.sets.push({ id, from: t.fontFamily, to: v, faces: snap() });
              }
              return Reflect.set(t, k, v);
            },
          });
          Object.defineProperty(term, 'options', {
            configurable: true,
            get: () => proxied,
            set: (v) => desc.set?.call(term, v),
          });
        }
        target[id] = term;
        return true;
      },
    },
  );
}

/** Same tap as update-toast.e2e.mjs (candidate for harness.mjs): record host-bound messages. */
async function tapHostMessages(app, { record, swallow = [] }) {
  await app.evaluate(
    ({ ipcMain }, opts) => {
      if (globalThis.__e2eHostTap) {
        Object.assign(globalThis.__e2eHostTap, opts);
        return;
      }
      const tap = { ...opts, seen: [] };
      globalThis.__e2eHostTap = tap;
      const real = ipcMain.listeners('to-host');
      ipcMain.removeAllListeners('to-host');
      ipcMain.on('to-host', (e, m) => {
        if (m && tap.record.includes(m.type)) tap.seen.push({ at: Date.now(), msg: m });
        if (m && tap.swallow.includes(m.type)) return;
        for (const l of real) l(e, m);
      });
    },
    { record, swallow },
  );
}
/** The renderer's `fonts`-scope log records since `since` (main-process clock). */
const fontLogs = (app, since) =>
  app.evaluate(
    (_, t) =>
      (globalThis.__e2eHostTap?.seen ?? [])
        .filter((x) => x.at >= t && x.msg.scope === 'fonts')
        .map((x) => ({ message: x.msg.message, level: x.msg.level, data: x.msg.data })),
    since,
  );
const mainNow = (app) => app.evaluate(() => Date.now());

/** Cancel the local mono faces outright, so the boot load rejects (or finds no face). */
async function failLocalFonts(app) {
  await app.evaluate(({ BrowserWindow }, src) => {
    const re = new RegExp(src, 'i');
    const ses = BrowserWindow.getAllWindows()[0].webContents.session;
    ses.webRequest.onBeforeRequest({ urls: ['file:///*'] }, (details, callback) =>
      callback(re.test(decodeURI(details.url)) ? { cancel: true } : {}),
    );
  }, TERMINAL_FACE_FILE.source);
}

/** "400" | "100 800" | "normal" | "bold" covers weight `w`. */
function coversWeight(weight, w) {
  const named = { normal: 400, bold: 700 };
  const [lo, hi] = String(weight)
    .split(/\s+/)
    .map((x) => named[x] ?? Number(x));
  return hi === undefined ? lo === w : lo <= w && w <= hi;
}
const loadedAt = (faces, family, w) =>
  faces.some((f) => f.family === family && f.status === 'loaded' && coversWeight(f.weight, w));
const describeFaces = (faces, family) =>
  faces
    .filter((f) => f.family === family)
    .map((f) => `${f.weight}:${f.status}`)
    .join(', ') || 'none registered';

async function reloadInstrumented(page) {
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
}

/** Both sessions' terminals constructed in this document. */
const waitTerms = (page, ids, timeout = 30000) =>
  page.waitForFunction((xs) => xs.every((id) => !!window.__terms?.[id]), ids, { timeout });

async function selectSession(page, id) {
  await page.click(`.session[data-sessionid="${id}"] .session__name`);
  await page.waitForFunction((s) => (window.__terms?.[s]?.element?.offsetWidth ?? 0) > 0, id, {
    timeout: 15000,
  });
}

runScenario('terminal-local-font', async ({ app, page, log }) => {
  const httpFontRequests = [];
  page.on('request', (r) => {
    const url = r.url();
    if (!/^https?:/i.test(url)) return;
    if (
      ['font', 'stylesheet'].includes(r.resourceType()) ||
      /fonts\.(googleapis|gstatic)\.com/i.test(url)
    ) {
      httpFontRequests.push(`${r.resourceType()} ${url}`);
    }
  });
  await tapHostMessages(app, { record: ['log'] });
  await page.addInitScript(instrumentTerminals);

  const a = await openSession(page, { path: REPO, agentId: 'shell:cmd' });
  const b = await openSession(page, { path: REPO, agentId: 'shell:cmd' });
  assert(a && b && a !== b, 'two shell sessions open');
  const { family: mono } = await terminalFace(page);
  const uiId = await page.evaluate(() => window.agentDeck.initialSettings?.fontUi ?? 'figtree');
  const ui = UI_FAMILY[uiId];
  log(`selected faces: mono ${mono}, ui ${uiId} (${ui ?? 'platform, not bundled'})`);

  // ── 1. Boot gate + offline local assets ───────────────────────────────────
  const gateHold = await holdBackLocalFonts(app, page, GATE_HOLD_MS);
  let since = await mainNow(app);
  await reloadInstrumented(page);
  await waitTerms(page, [a, b]);
  const first = await page.evaluate(() => window.__fontEv.first);
  assert(first, 'the first terminal construction was observed');
  for (const w of [400, 700]) {
    assert(
      loadedAt(first.faces, mono, w),
      `boot: ${mono} ${w} loaded before the first terminal (faces ${describeFaces(first.faces, mono)})`,
    );
    if (ui) {
      assert(
        loadedAt(first.faces, ui, w),
        `boot: UI ${ui} ${w} loaded before the first terminal (faces ${describeFaces(first.faces, ui)})`,
      );
    }
  }
  log(
    `boot: first terminal at ${Math.round(first.at)}ms with ${mono} [${describeFaces(first.faces, mono)}], Cascadia Mono [${describeFaces(first.faces, 'Cascadia Mono')}]`,
  );
  await assertFontsHeldBack(gateHold, 'boot gate');
  let logs = await fontLogs(app, since);
  assert(
    !logs.some((l) => /timed out|failed|no face/.test(l.message)),
    `a ${GATE_HOLD_MS}ms face is waited for, not given up on (fonts logs ${JSON.stringify(logs)})`,
  );

  // performance.getEntriesByType('resource') lists no file: font loads in Electron; the
  // holdBackLocalFonts onBeforeRequest tap records the emitted out/*.ttf URLs instead.
  const recordedFonts = await tapLocalFontRequests(app, page);
  const bundledMono = recordedFonts.filter((n) => TERMINAL_FACE_FILE.test(n));
  const nonLocal = recordedFonts.filter((n) => !n.startsWith('file:'));
  log(`offline: ${recordedFonts.length} font files, e.g. ${bundledMono[0]}`);
  assert(nonLocal.length === 0, `every font is a local file (${nonLocal.join(', ')})`);
  assert(bundledMono.length > 0, 'the terminal face came from the emitted out/ files');
  const offline = await page.evaluate(() => {
    const remoteRules = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        remoteRules.push(`unreadable sheet ${sheet.href}`);
        continue;
      }
      for (const r of rules) {
        if (r instanceof CSSImportRule && /^https?:/i.test(r.href)) remoteRules.push(r.href);
        if (r instanceof CSSFontFaceRule && /https?:/i.test(r.style.getPropertyValue('src')))
          remoteRules.push(r.style.getPropertyValue('src'));
      }
    }
    return {
      remoteRules,
      csp:
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute('content') ?? null,
      violations: window.__fontEv.csp,
    };
  });
  assert(offline.remoteRules.length === 0, `no remote @import/@font-face (${offline.remoteRules})`);
  const fontSrc = /font-src([^;]*)/.exec(offline.csp ?? '')?.[1]?.trim();
  assert(fontSrc === "'self'", `CSP font-src is 'self' only (got ${JSON.stringify(fontSrc)})`);
  assert(!/googleapis|gstatic/i.test(offline.csp ?? ''), 'the CSP names no Google font origin');
  assert(
    !offline.violations.some((v) => /font-src|style-src/.test(v.directive)),
    `no font/style CSP violation (${JSON.stringify(offline.violations)})`,
  );
  log('boot gate: selected faces loaded before the first terminal; all fonts local ✓');

  // ── 2. A rejected load logs and the sessions still open ───────────────────
  await failLocalFonts(app);
  since = await mainNow(app);
  await reloadInstrumented(page);
  await waitTerms(page, [a, b]);
  logs = await fontLogs(app, since);
  assert(
    logs.some((l) => /font load (failed|found no face)/.test(l.message) && l.level === 'warn'),
    `a rejected boot load is logged as a warning (fonts logs ${JSON.stringify(logs)})`,
  );
  await selectSession(page, a);
  await typeLine(page, a, 'echo REJECTED-FONT-OK');
  await waitForOutput(page, a, 'REJECTED-FONT-OK');
  log(
    `rejected load: logged "${logs.find((l) => /font load/.test(l.message))?.message}", session runs ✓`,
  );

  // ── 3. Timed-out boot, late face, every terminal refreshed ────────────────
  const lateHold = await holdBackLocalFonts(app, page, LATE_HOLD_MS);
  since = await mainNow(app);
  await reloadInstrumented(page);
  await waitTerms(page, [a, b], LATE_HOLD_MS);
  const early = await page.evaluate(
    ({ ids, fam }) => ({
      mounts: ids.map((id) => window.__fontEv.mounts[id]?.faces ?? []),
      monoLoadedNow: [...document.fonts].some(
        (f) => f.family.replace(/^["']|["']$/g, '') === fam && f.status === 'loaded',
      ),
      atlas: ids.map((id) => window.__fontEv.atlas[id]),
    }),
    { ids: [a, b], fam: mono },
  );
  for (const [i, id] of [a, b].entries()) {
    assert(
      !loadedAt(early.mounts[i], mono, 400),
      `timed-out boot: terminal ${id} mounted before its face (faces ${describeFaces(early.mounts[i], mono)})`,
    );
  }
  assert(!early.monoLoadedNow, `the ${mono} face is still held while both terminals exist`);
  logs = await fontLogs(app, since);
  const timedOut = logs.find((l) => l.message === 'font load timed out');
  assert(timedOut, `the boot timeout is logged (fonts logs ${JSON.stringify(logs)})`);
  assert(
    timedOut.data?.timeoutMs === BOOT_FONT_TIMEOUT_MS,
    `logged with the ${BOOT_FONT_TIMEOUT_MS}ms budget (${JSON.stringify(timedOut.data)})`,
  );

  await page.waitForFunction(
    (fam) =>
      [...document.fonts].some(
        (f) => f.family.replace(/^["']|["']$/g, '') === fam && f.status === 'loaded',
      ),
    mono,
    { timeout: LATE_HOLD_MS + 15000 },
  );
  const refreshed = await page
    .waitForFunction(
      ({ ids, base }) => ids.every((id, i) => window.__fontEv.atlas[id] > base[i]),
      { ids: [a, b], base: early.atlas },
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  const atlasNow = await page.evaluate((ids) => ids.map((id) => window.__fontEv.atlas[id]), [a, b]);
  assert(
    refreshed,
    `the late ${mono} face clears the atlas of BOTH terminals (clearTextureAtlas ${JSON.stringify(early.atlas)} → ${JSON.stringify(atlasNow)})`,
  );
  await assertFontsHeldBack(lateHold, 'late face');
  for (const id of [a, b]) {
    await selectSession(page, id);
    const w = await measureCellWidth(page, id);
    assert(w, `terminal ${id} can be measured`);
    log(
      `late face, ${id}: cell ${w.cell}px, ${w.face} ${w.expected}px, fallback ${w.fallback}px${w.expected === w.fallback ? ' (same width: this size cannot tell the faces apart)' : ''}`,
    );
    assert(w.loaded, `${w.face} is loaded for ${id}`);
    assert(
      Math.abs(w.cell - w.expected) < 0.05,
      `terminal ${id} re-measured in the late face: cell ${w.cell}px, ${w.face} makes ${w.expected}px`,
    );
    const size = await probeTerminalSize(page, id, `LATE-${id.slice(0, 6)}`);
    assert(
      size.xterm === size.pty,
      `after the late face ${id}: xterm ${size.xterm}, PTY ${size.pty}`,
    );
    assert(
      size.screenH > 0 && size.screenH <= size.paneH,
      `after the late face ${id}: screen ${size.screenH}px fits its ${size.paneH}px pane`,
    );
  }
  log('timed-out boot logged; late face refreshed and re-fitted both terminals ✓');

  // ── 4. Glyphs in the terminal's own stack ─────────────────────────────────
  await selectSession(page, a);
  const stackInfo = await page.evaluate((id) => {
    const t = window.__terms[id];
    return { stack: String(t.options.fontFamily), px: Number(t.options.fontSize) };
  }, a);
  const families = stackInfo.stack.split(',').map((f) => f.trim().replace(/^["']|["']$/g, ''));
  assert(
    families[0] === mono &&
      families.indexOf('Cascadia Mono') === 1 &&
      families.indexOf('Segoe UI Symbol') === 2 &&
      families.slice(3).every((f) => /monospace/.test(f)),
    `the terminal stack is ${mono}, Cascadia Mono, Segoe UI Symbol, then generics (got ${stackInfo.stack})`,
  );
  await page.evaluate(
    async ({ stack, px, chars }) => {
      await document.fonts.load(`${px}px ${stack}`, chars.join(''));
      await document.fonts.load(`64px ${stack}`, chars.join(''));
      const host = document.createElement('div');
      host.id = 'e2e-glyphs';
      host.style.cssText = 'position:fixed;left:-10000px;top:0;white-space:pre';
      chars.forEach((ch, i) => {
        const s = document.createElement('span');
        s.id = `e2e-glyph-${i}`;
        s.style.fontFamily = stack;
        s.style.fontSize = `${px}px`;
        s.textContent = ch;
        host.appendChild(s);
      });
      document.body.appendChild(host);
      await new Promise((r) => requestAnimationFrame(() => r()));
    },
    { ...stackInfo, chars: GLYPHS },
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const used = [];
  for (const [i, ch] of GLYPHS.entries()) {
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: `#e2e-glyph-${i}`,
    });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    used.push({ ch, fonts });
  }
  await cdp.detach();

  // A bundled face reports its file's own family name; map it back to the name the stack uses.
  const cssFamilyOf = (f) =>
    !f
      ? 'monospace'
      : f.isCustomFont
        ? (families.find((x) => f.familyName === x || f.familyName.startsWith(`${x} `)) ??
          f.familyName)
        : f.familyName;
  const glyphs = await page.evaluate(
    ({ stack, px, items }) => {
      const SIZE = 64;
      const W = 128;
      const H = 96;
      const draw = (family, ch) => {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const ctx = c.getContext('2d');
        ctx.font = `${SIZE}px ${family}`;
        const fontOk = ctx.font.includes(String(SIZE));
        ctx.fillStyle = '#000';
        ctx.fillText(ch, 16, 72);
        return { data: ctx.getImageData(0, 0, W, H).data, fontOk };
      };
      const ctx = document.createElement('canvas').getContext('2d');
      const advance = (family, ch) => {
        ctx.font = `${px}px ${family}`;
        return ctx.measureText(ch).width;
      };
      const cell = advance(stack, 'W');
      return items.map(({ ch, source }) => {
        const inStack = draw(stack, ch);
        const alone = draw(`'${source}'`, ch);
        let inked = 0;
        let maxChroma = 0;
        let maxDiff = 0;
        for (let p = 0; p < inStack.data.length; p += 4) {
          const [r, g, bl, al] = inStack.data.slice(p, p + 4);
          if (al > 40) {
            inked++;
            maxChroma = Math.max(maxChroma, Math.max(r, g, bl) - Math.min(r, g, bl));
          }
          for (let k = 0; k < 4; k++)
            maxDiff = Math.max(maxDiff, Math.abs(inStack.data[p + k] - alone.data[p + k]));
        }
        return {
          ch,
          source,
          fontOk: inStack.fontOk && alone.fontOk,
          inked,
          maxChroma,
          sameAsSource: maxDiff <= 8,
          maxDiff,
          advance: Math.round(advance(stack, ch) * 1000) / 1000,
          sourceCell: Math.round(advance(`'${source}'`, 'W') * 1000) / 1000,
          cell: Math.round(cell * 1000) / 1000,
        };
      });
    },
    {
      ...stackInfo,
      items: used.map(({ ch, fonts }) => ({ ch, source: cssFamilyOf(fonts[0]) })),
    },
  );
  await page.evaluate(() => document.getElementById('e2e-glyphs')?.remove());

  for (const g of glyphs) {
    const report = used.find((u) => u.ch === g.ch).fonts;
    log(
      `glyph ${g.ch}: ${report.map((f) => `${f.familyName}${f.isCustomFont ? ' (bundled)' : ' (OS)'}×${f.glyphCount}`).join(' + ')}; advance ${g.advance}px vs cell ${g.cell}px (${Math.round((g.advance / g.cell) * 100)}%), chroma ${g.maxChroma}, canvas = ${g.source} alone: ${g.sameAsSource} (Δ${g.maxDiff})`,
    );
    assert(report.length === 1, `${g.ch} renders from one face (${JSON.stringify(report)})`);
    const face = { ...report[0], familyName: cssFamilyOf(report[0]) };
    assert(
      !/emoji/i.test(face.familyName),
      `${g.ch} is not drawn from an emoji face (${face.familyName})`,
    );
    assert(g.fontOk, `${g.ch}: the canvas accepted the font strings`);
    assert(g.inked > 20, `${g.ch} draws visible ink (${g.inked} px) — not a blank/missing glyph`);
    assert(g.maxChroma <= 30, `${g.ch} is monochrome on canvas (max chroma ${g.maxChroma})`);
    assert(
      g.sameAsSource,
      `${g.ch}: canvas in the terminal stack draws ${face.familyName}'s glyph (max Δ ${g.maxDiff})`,
    );
    if ('❯●'.includes(g.ch)) {
      // Cascadia Mono's cmap has both (test/unit/font-bundle.test.ts); a primary that has them wins.
      assert(
        face.isCustomFont && [mono, 'Cascadia Mono'].includes(face.familyName),
        `${g.ch} comes from a bundled mono face (${mono} or Cascadia Mono), got ${face.familyName}${face.isCustomFont ? '' : ' (OS)'}`,
      );
      assert(
        Math.abs(g.advance - g.sourceCell) < 0.05,
        `${g.ch} has its mono face's uniform advance (${g.advance}px vs ${face.familyName} ${g.sourceCell}px)`,
      );
      assert(g.advance <= g.cell + 0.05, `${g.ch} fits one cell (${g.advance}px in ${g.cell}px)`);
    } else if ('✔⏺⎿'.includes(g.ch)) {
      // No bundled mono face has these (measured cmaps), so the stack's Segoe UI Symbol must.
      assert(
        face.familyName === 'Segoe UI Symbol',
        `${g.ch} comes from Segoe UI Symbol, the stack's symbol face (got ${face.familyName})`,
      );
    } else {
      assert(
        [mono, 'Cascadia Mono', 'Segoe UI Symbol'].includes(face.familyName),
        `${g.ch} comes from a face the stack names (got ${face.familyName})`,
      );
    }
  }
  log('glyphs: each from its intended face, monochrome, canvas agrees ✓');

  // ── 5. A font change loads before the option changes ──────────────────────
  const next = { id: 'jetbrains', family: 'JetBrains Mono' };
  assert(next.family !== mono, 'the change target differs from the booted face');
  const precondition = await page.evaluate(
    (fam) =>
      [...document.fonts]
        .filter((f) => f.family.replace(/^["']|["']$/g, '') === fam)
        .map((f) => f.status),
    next.family,
  );
  assert(
    precondition.length > 0 && !precondition.includes('loaded'),
    `${next.family} is registered and not loaded before the change (${precondition})`,
  );
  const changeHold = await holdBackLocalFonts(app, page, CHANGE_HOLD_MS);
  await page.evaluate(
    (id) =>
      new Promise((resolve) => {
        let sent = false;
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'state') return;
          if (!sent) {
            sent = true;
            window.agentDeck.post({
              type: 'updateSettings',
              settings: { ...m.settings, fontMono: id, fontMonoPinned: true },
            });
          }
          if (m.settings?.fontMono === id) {
            off();
            resolve();
          }
        });
        window.agentDeck.post({ type: 'ready' });
      }),
    next.id,
  );
  await page.waitForFunction(
    ({ ids, fam }) =>
      ids.every((id) => String(window.__terms[id]?.options.fontFamily).includes(fam)),
    { ids: [a, b], fam: next.family },
    { timeout: BOOT_FONT_TIMEOUT_MS + 10000 },
  );
  const sets = await page.evaluate(
    (fam) => window.__fontEv.sets.filter((s) => String(s.to).includes(fam)),
    next.family,
  );
  for (const id of [a, b]) {
    const set = sets.find((s) => s.id === id);
    assert(set, `terminal ${id} switched to ${next.family}`);
    for (const w of [400, 700]) {
      assert(
        loadedAt(set.faces, next.family, w),
        `${id}: ${next.family} ${w} loaded before fontFamily changed (faces ${describeFaces(set.faces, next.family)})`,
      );
    }
  }
  await assertFontsHeldBack(changeHold, 'font change');
  log(
    `font change: ${next.family} loaded (held ${CHANGE_HOLD_MS}ms) before both terminals switched ✓`,
  );

  // ── 6. TERM and PTY geometry ──────────────────────────────────────────────
  await selectSession(page, a);
  await typeLine(page, a, 'echo TERMPROBE=%TERM%');
  const term = await page
    .waitForFunction(
      (id) => {
        const t = window.__terms?.[id];
        if (!t) return null;
        const b = t.buffer.active;
        for (let i = 0; i < b.length; i++) {
          const m = /^TERMPROBE=(\S+)\s*$/.exec(b.getLine(i)?.translateToString(true) ?? '');
          if (m) return m[1];
        }
        return null;
      },
      a,
      { timeout: 20000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  assert(
    term === 'xterm-256color',
    `the PTY's TERM is xterm-256color (got ${JSON.stringify(term)}; tail ${JSON.stringify((await logicalLines(page, a))?.slice(-4))})`,
  );
  const size = await probeTerminalSize(page, a, 'FINAL-GEOMETRY');
  assert(size.xterm === size.pty, `after the font change: xterm ${size.xterm}, PTY ${size.pty}`);
  assert(
    size.screenH > 0 && size.screenH <= size.paneH,
    `after the font change: screen ${size.screenH}px fits its ${size.paneH}px pane`,
  );
  log(`TERM ${term}; PTY ${size.pty} = xterm ${size.xterm} ✓`);

  assert(
    httpFontRequests.length === 0,
    `no http(s) font/stylesheet request all run (${httpFontRequests.join(', ')})`,
  );
});
