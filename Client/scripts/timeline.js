/* Timeline view: a zoomable time axis with one lane per kind. Entries that
   overlap in time stack into sub-rows inside their lane, the way clips stack
   on tracks in an editor. Packing is computed from time (not pixels) so rows
   stay put while you zoom. */
(() => {
const { el, esc, $, $$, fmtTime, fmtDate, fmtDur, fmtSpan, shifted, offsetFor, MIN, debounce } = M.ui;
const { KINDS, kindOf, state } = M.store;
const ic = M.icons;

const SEC = 1000, MINU = 60 * SEC, HOUR = 60 * MINU, DAY = 24 * HOUR;
const STEPS = [SEC, 2*SEC, 5*SEC, 10*SEC, 15*SEC, 30*SEC, MINU, 2*MINU, 5*MINU, 10*MINU,
  15*MINU, 30*MINU, HOUR, 2*HOUR, 3*HOUR, 6*HOUR, 12*HOUR, DAY, 2*DAY, 7*DAY, 14*DAY];
const MIN_SPAN = 2 * SEC, MAX_SPAN = 10 * 365 * DAY;
const ROW_H = 56, ROW_GAP = 8, LANE_PAD = 8;

M.timeline = { mount(root) {
  const now = Date.now();
  let t0 = now - 6 * HOUR, pxms = 0, W = 0;           // left edge + scale
  let lanes = [], packed = new Map(), frame = 0;

  root.innerHTML = '';
  const wrap = el('div', { class: 'tl' });
  const ruler = el('div', { class: 'tl-ruler' });
  const body = el('div', { class: 'tl-body' });
  const grid = el('div', { class: 'tl-grid' });
  const nowLine = el('div', { class: 'tl-now' });
  const scale = el('div', { class: 'tl-scale glass' });
  const hud = el('div', { class: 'tl-hud glass' });
  body.append(grid);
  wrap.append(ruler, body, nowLine, scale, hud);
  root.append(wrap);

  const btn = (icon, label, fn) => {
    const b = el('button', { title: label, 'aria-label': label }, ic(icon, 16));
    b.onclick = fn; return b;
  };
  hud.append(
    btn('plus', 'Zoom in', () => zoomBy(1.6, W / 2)),
    btn('minus', 'Zoom out', () => zoomBy(1 / 1.6, W / 2)),
    btn('focus', 'Fit all entries', fitAll),
    btn('clock', 'Jump to now', () => { setSpan(6 * HOUR, Date.now() - 5 * HOUR); }));

  /* ---- scale ------------------------------------------------------------ */
  const span = () => W / pxms;
  const setSpan = (s, left) => {
    s = Math.max(MIN_SPAN, Math.min(MAX_SPAN, s));
    pxms = W / s;
    if (left != null) t0 = left;
    schedule(true);
  };
  const zoomBy = (factor, anchorPx) => {
    const anchorT = t0 + anchorPx / pxms;
    const next = Math.max(MIN_SPAN, Math.min(MAX_SPAN, span() / factor));
    pxms = W / next;
    t0 = anchorT - anchorPx / pxms;
    schedule(true);
  };
  function fitAll() {
    const es = M.store.visible();
    if (!es.length) return setSpan(6 * HOUR, Date.now() - 5 * HOUR);
    let lo = Infinity, hi = -Infinity;
    for (const e of es) { lo = Math.min(lo, +new Date(e.startsAt)); hi = Math.max(hi, +new Date(e.endsAt)); }
    const pad = Math.max(MINU, (hi - lo) * 0.06);
    setSpan((hi - lo) + pad * 2, lo - pad);
  }

  /* ---- packing ----------------------------------------------------------
     Within a lane, an entry drops into the first sub-row whose previous clip
     has already ended. Time-based, so rows do not reshuffle while zooming. */
  const pack = () => {
    packed = new Map(); lanes = [];
    for (const k of KINDS) {
      if (!state.kinds.has(k.id)) continue;
      const es = M.store.visible().filter(e => e.kind === k.id)
        .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
      const ends = [];
      for (const e of es) {
        const s = +new Date(e.startsAt), en = Math.max(+new Date(e.endsAt), s + 1);
        let row = ends.findIndex(t => t <= s);
        if (row < 0) { row = ends.length; ends.push(0); }
        ends[row] = en;
        packed.set(e.id, row);
      }
      lanes.push({ kind: k, entries: es, rows: Math.max(1, ends.length) });
    }
  };

  /* ---- DOM ------------------------------------------------------------- */
  const laneEls = new Map();   // kind id -> {lane, track, els:Map(id->el)}
  const build = () => {
    pack();
    for (const [id, rec] of laneEls) if (!lanes.some(l => l.kind.id === id)) { rec.lane.remove(); laneEls.delete(id); }
    for (const l of lanes) {
      let rec = laneEls.get(l.kind.id);
      if (!rec) {
        const lane = el('div', { class: 'lane', style: `--k:${l.kind.color}` });
        const label = el('div', { class: 'lane-label' }, `${ic(l.kind.icon, 14)}<span>${l.kind.label}</span>`);
        const track = el('div', { class: 'lane-track' });
        lane.append(label, track);
        body.append(lane);
        rec = { lane, track, els: new Map() };
        laneEls.set(l.kind.id, rec);
      }
      rec.lane.style.height = (l.rows * ROW_H + (l.rows - 1) * ROW_GAP + LANE_PAD * 2) + 'px';
      const seen = new Set();
      for (const e of l.entries) {
        seen.add(e.id);
        let n = rec.els.get(e.id);
        if (!n) { n = blockEl(e); rec.track.append(n); rec.els.set(e.id, n); }
        else if (n.dataset.sig !== sig(e)) { const f = blockEl(e); rec.track.replaceChild(f, n); rec.els.set(e.id, f); n = f; }
      }
      for (const [id, n] of rec.els) if (!seen.has(id)) { n.remove(); rec.els.delete(id); }
    }
    place();
  };

  const sig = e => `${e.status}|${e.title}|${e.thumb || ''}|${e.size}|${e.startsAt}|${e.endsAt}`;

  const blockEl = e => {
    const k = kindOf(e.kind);
    const n = el('div', { class: 'blk' + (e.status === 'recording' ? ' live' : ''), 'data-id': e.id, tabindex: '0' });
    n.dataset.sig = sig(e);
    n.style.setProperty('--k', k.color);
    if (e.thumb) n.append(el('img', { src: M.api.blobURL(e.thumb, 'image/jpeg'), alt: '', loading: 'lazy', decoding: 'async' }));
    else if (e.peaks?.length) {
      const w = el('div', { class: 'wave' });
      const step = Math.ceil(e.peaks.length / 60);
      for (let i = 0; i < e.peaks.length; i += step)
        w.append(el('i', { style: `height:${Math.max(4, e.peaks[i] * 100)}%` }));
      n.append(w);
    }
    n.append(el('div', { class: 't' }, esc(title(e))));
    n.title = `${title(e)} · ${fmtDate(e.startsAt, offsetFor(e))} ${fmtTime(e.startsAt, offsetFor(e))} · ${fmtDur(e.durationMs)}`;
    const open = () => M.viewer.open(e.id);
    n.onclick = open;
    n.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
    return n;
  };
  const title = e => e.title || (e.text ? e.text.slice(0, 60).split('\n')[0] : '') || kindOf(e.kind).label;

  /* ---- placement (runs on every pan / zoom frame) ----------------------- */
  const place = () => {
    const t1 = t0 + span();
    /* ruler + grid */
    const ts = makeTicks(t0, t1, pxms);
    sync(ruler, ts.length, () => el('div', { class: 'tick' }), (n, i) => {
      const t = ts[i];
      n.className = 'tick' + (t.major ? ' major' : '');
      n.style.transform = `translateX(${(t.t - t0) * pxms}px)`;
      n.textContent = t.label;
    });
    sync(grid, ts.length, () => el('i'), (n, i) => {
      n.style.transform = `translateX(${(ts[i].t - t0) * pxms}px)`;
      n.style.opacity = ts[i].major ? .8 : .4;
    });

    for (const l of lanes) {
      const rec = laneEls.get(l.kind.id);
      if (!rec) continue;
      for (const e of l.entries) {
        const n = rec.els.get(e.id); if (!n) continue;
        const s = +new Date(e.startsAt), en = Math.max(+new Date(e.endsAt), s + 1);
        if (en < t0 || s > t1) { n.style.display = 'none'; continue; }
        const x = (s - t0) * pxms;
        const w = Math.max(3, (en - s) * pxms);
        n.style.display = '';
        n.classList.toggle('tiny', w < 26);
        n.style.transform = `translate(${x}px,${packed.get(e.id) * (ROW_H + ROW_GAP) + LANE_PAD}px)`;
        n.style.width = w + 'px';
      }
    }

    grid.style.height = body.scrollHeight + 'px';

    const nx = (Date.now() - t0) * pxms;
    nowLine.style.display = nx >= 0 && nx <= W ? '' : 'none';
    nowLine.style.transform = `translateX(${nx}px)`;
    scale.textContent = `${fmtSpan(span())} across · ${fmtDate(new Date(t0 + span() / 2).toISOString())}`;
    fetchWindow();
  };

  /* Reuse child nodes instead of rebuilding the ruler every frame. */
  const sync = (parent, count, make, update) => {
    while (parent.children.length < count) parent.append(make());
    while (parent.children.length > count) parent.lastChild.remove();
    for (let i = 0; i < count; i++) update(parent.children[i], i);
  };

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    frame = requestAnimationFrame(() => { pending = false; place(); });
  };

  const fetchWindow = debounce(() => {
    const s = span();
    M.store.load(new Date(t0 - s), new Date(t0 + s * 2));
  }, 220);

  /* ---- interaction ------------------------------------------------------ */
  body.addEventListener('wheel', ev => {
    const px = ev.clientX - body.getBoundingClientRect().left;
    if (ev.ctrlKey || ev.metaKey) {           // trackpad pinch
      ev.preventDefault(); zoomBy(Math.exp(-ev.deltaY * 0.01), px);
    } else if (ev.shiftKey) {                  // shift -> scroll the lane stack
      ev.preventDefault(); body.scrollTop += ev.deltaY;
    } else if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
      ev.preventDefault(); t0 += ev.deltaX / pxms; schedule();
    } else {
      ev.preventDefault(); zoomBy(Math.exp(-ev.deltaY * 0.0022), px);
    }
  }, { passive: false });

  let drag = null;
  body.addEventListener('pointerdown', ev => {
    if (ev.target.closest('.blk')) return;
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t0, top: body.scrollTop };
    body.setPointerCapture(ev.pointerId);
    body.classList.add('dragging');
  });
  body.addEventListener('pointermove', ev => {
    if (!drag || drag.id !== ev.pointerId) return;
    t0 = drag.t0 - (ev.clientX - drag.x) / pxms;
    body.scrollTop = drag.top - (ev.clientY - drag.y);
    schedule();
  });
  const endDrag = ev => {
    if (!drag) return;
    body.classList.remove('dragging');
    try { body.releasePointerCapture(drag.id); } catch {}
    drag = null;
  };
  body.addEventListener('pointerup', endDrag);
  body.addEventListener('pointercancel', endDrag);

  /* two-finger pinch on touch */
  const touches = new Map();
  let pinch = null;
  wrap.addEventListener('touchstart', ev => {
    if (ev.touches.length === 2) {
      const [a, b] = ev.touches;
      pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
                mid: (a.clientX + b.clientX) / 2 - wrap.getBoundingClientRect().left, span: span() };
      drag = null; body.classList.remove('dragging');
    }
  }, { passive: true });
  wrap.addEventListener('touchmove', ev => {
    if (pinch && ev.touches.length === 2) {
      ev.preventDefault();
      const [a, b] = ev.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const anchorT = t0 + pinch.mid / pxms;
      pxms = W / Math.max(MIN_SPAN, Math.min(MAX_SPAN, pinch.span * (pinch.d / Math.max(1, d))));
      t0 = anchorT - pinch.mid / pxms;
      schedule();
    }
  }, { passive: false });
  wrap.addEventListener('touchend', ev => { if (ev.touches.length < 2) pinch = null; }, { passive: true });

  const onKey = ev => {
    if (ev.target.matches('input,textarea')) return;
    const s = span();
    if (ev.key === 'ArrowLeft') { t0 -= s * .15; schedule(); }
    else if (ev.key === 'ArrowRight') { t0 += s * .15; schedule(); }
    else if (ev.key === '+' || ev.key === '=') zoomBy(1.6, W / 2);
    else if (ev.key === '-') zoomBy(1 / 1.6, W / 2);
    else if (ev.key === 'ArrowUp') body.scrollTop -= 60;
    else if (ev.key === 'ArrowDown') body.scrollTop += 60;
    else if (ev.key.toLowerCase() === 'f') fitAll();
  };
  document.addEventListener('keydown', onKey);

  const ro = new ResizeObserver(() => {
    const prev = W ? span() : 6 * HOUR;
    W = body.clientWidth;
    pxms = W / prev;
    place();
  });
  ro.observe(body);

  const tick = setInterval(() => { if (state.entries.size) schedule(); }, 1000);

  W = body.clientWidth || 1200;
  pxms = W / (6 * HOUR);
  build();
  setTimeout(fitAll, 400);

  return {
    render: build,
    fit: fitAll,
    destroy() { ro.disconnect(); clearInterval(tick); document.removeEventListener('keydown', onKey); cancelAnimationFrame(frame); },
  };
}};

/* ---- tick generation -----------------------------------------------------
   Picks the finest step that still leaves ~90px between labels, then walks
   calendar-aligned boundaries in the display timezone.                     */
function makeTicks(t0, t1, pxms) {
  const off = M.ui.localOffset();   // the axis itself is always the viewer's clock
  const want = 90 / pxms;
  const out = [];
  const push = (t, label, major) => { if (t >= t0 - 1 && t <= t1) out.push({ t, label, major }); };

  const step = STEPS.find(s => s >= want);
  if (step) {
    const shift = off * MIN;
    let t = Math.ceil((t0 + shift) / step) * step - shift;
    for (; t <= t1 && out.length < 300; t += step) {
      const d = shifted(new Date(t).toISOString(), off);
      const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
      let label;
      if (step >= DAY) label = `${d.getUTCDate()} ${MONS[d.getUTCMonth()]}`;
      else if (step < MINU) label = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      else label = midnight ? `${d.getUTCDate()} ${MONS[d.getUTCMonth()]}` : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      push(t, label, midnight || step >= DAY);
    }
    return out;
  }
  // Beyond two weeks per label, step by whole months or years.
  const monthsPerStep = [1, 3, 6, 12, 24, 60, 120].find(m => m * 30 * DAY >= want) || 120;
  const start = shifted(new Date(t0).toISOString(), off);
  let y = start.getUTCFullYear(), mo = Math.floor(start.getUTCMonth() / monthsPerStep) * monthsPerStep;
  for (let i = 0; i < 300; i++) {
    const t = Date.UTC(y, mo, 1) - off * MIN;
    if (t > t1) break;
    push(t, monthsPerStep >= 12 ? String(y) : `${MONS[mo]} ${String(y).slice(2)}`, mo === 0);
    mo += monthsPerStep;
    while (mo >= 12) { mo -= 12; y++; }
  }
  return out;
}
const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pad = n => String(n).padStart(2, '0');
})();
