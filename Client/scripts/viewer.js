/* Entry viewer: playback, metadata, and the server-side trim / crop /
   compress panel. */
(() => {
const { el, esc, modal, toast, confirm, fmtFull, fmtDur, fmtBytes, fmtTZ, md, debounce } = M.ui;
const { kindOf } = M.store;
const ic = M.icons;

const open = async id => {
  let e;
  try { e = await M.api.get(id); } catch (err) { return toast(err.message, 'err'); }
  M.store.upsert(e);
  const k = kindOf(e.kind);

  const body = el('div', { class: 'col', style: 'gap:14px' });

  /* ---- media ---- */
  let mediaEl = null;
  if (e.blob && (e.kind === 'video' || e.kind === 'audio' || e.kind === 'image')) {
    const box = el('div', { class: 'viewer-media' });
    const src = M.api.blobURL(e.blob, e.mime);
    if (e.kind === 'video') mediaEl = el('video', { src, controls: '', playsinline: '', preload: 'metadata' });
    else if (e.kind === 'audio') mediaEl = el('audio', { src, controls: '', preload: 'metadata' });
    else mediaEl = el('img', { src, alt: esc(e.title || 'Image'), decoding: 'async' });
    box.append(mediaEl);
    body.append(box);
  } else if (e.kind === 'markdown') {
    body.append(el('div', { class: 'md-preview card', style: 'padding:14px' }, md(e.text) || '<p class="dim">Empty note.</p>'));
  } else if (e.kind === 'stroke') {
    body.append(strokeView(e));
  } else if (e.status === 'recording') {
    body.append(el('div', { class: 'card', style: 'padding:16px;text-align:center' },
      '<span class="muted">This capture is still being uploaded.</span>'));
  }

  /* ---- title / tags ---- */
  const titleIn = el('input', { class: 'input', placeholder: 'Title', value: e.title || '' });
  const tagsIn = el('input', { class: 'input', placeholder: 'Tags, comma separated', value: (e.tags || []).join(', ') });
  const saveMeta = debounce(async () => {
    try {
      const upd = await M.api.patch(e.id, {
        title: titleIn.value,
        tags: tagsIn.value.split(',').map(s => s.trim()).filter(Boolean),
      });
      Object.assign(e, upd); M.store.upsert(upd); M.store.emit();
    } catch (err) { toast(err.message, 'err'); }
  }, 700);
  titleIn.oninput = tagsIn.oninput = saveMeta;
  body.append(el('div', { class: 'field' }, '<label>Title</label>'), titleIn);
  body.append(el('div', { class: 'field' }, '<label>Tags</label>'), tagsIn);

  /* ---- metadata ---- */
  const meta = el('dl', { class: 'meta-grid card', style: 'padding:12px' });
  const rows = [
    ['Kind', k.label],
    ['Started', `${fmtFull(e.startsAt, e.tzOffset)} ${fmtTZ(e.tzOffset)}`],
    ['Ended', `${fmtFull(e.endsAt, e.tzOffset)}`],
    ['Duration', fmtDur(e.durationMs)],
    ['Size', fmtBytes(e.size)],
    e.mime && ['Format', e.mime],
    e.meta?.width && ['Dimensions', `${e.meta.width}×${e.meta.height}`],
    e.meta?.codec && ['Codec', e.meta.codec],
    e.blob && ['Blob', e.blob.slice(0, 16) + '…'],
  ].filter(Boolean);
  meta.innerHTML = rows.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('');
  body.append(meta);

  /* ---- edit panel ---- */
  const host = {};   // filled in once the modal exists
  if (e.blob && e.kind !== 'markdown' && e.kind !== 'stroke') body.append(editPanel(e, mediaEl, host));

  /* ---- footer ---- */
  const del = el('button', { class: 'btn btn-danger' }, `${ic('trash', 15)}Delete`);
  const dl = el('a', { class: 'btn', href: e.blob ? M.api.blobURL(e.blob, e.mime) + '&download=1' : '#', download: '' },
    `${ic('download', 15)}Download`);
  if (!e.blob) dl.classList.add('hidden');
  const editBtn = el('button', { class: 'btn' }, `${ic('markdown', 15)}Edit`);
  if (e.kind !== 'markdown' && e.kind !== 'stroke') editBtn.classList.add('hidden');
  const close = el('button', { class: 'btn btn-primary' }, 'Close');

  const m = modal({ title: e.title || k.label, body, wide: true,
    foot: [del, el('div', { class: 'grow' }), dl, editBtn, close],
    onClose: () => { if (mediaEl?.pause) mediaEl.pause(); } });

  host.close = () => m.close();
  close.onclick = () => m.close();
  editBtn.onclick = () => { m.close(); (e.kind === 'markdown' ? M.capture.writeMarkdown : M.capture.drawStroke)(e); };
  del.onclick = async () => {
    if (!await confirm('Delete entry', 'This permanently removes the entry and its file.')) return;
    try {
      await M.api.del(e.id);
      M.store.remove(e.id); M.store.emit();
      m.close(); toast('Entry deleted');
    } catch (err) { toast(err.message, 'err'); }
  };
};

/* Replay a stored stroke note at whatever size the viewer has. */
const strokeView = e => {
  const cv = el('canvas', { class: 'pad', style: 'cursor:default' });
  const draw = () => {
    let strokes = []; try { strokes = JSON.parse(e.text || '[]'); } catch {}
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const st of strokes) {
      // e:1 marks an eraser stroke; replay it the same way the pad drew it.
      ctx.globalCompositeOperation = st.e ? 'destination-out' : 'source-over';
      ctx.strokeStyle = st.c; ctx.lineWidth = st.w;
      ctx.beginPath();
      for (let i = 0; i < st.p.length; i += 2) {
        const x = st.p[i] * r.width, y = st.p[i + 1] * r.height;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      if (st.p.length === 2) ctx.lineTo(st.p[0] * r.width + 0.01, st.p[1] * r.height);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  };
  new ResizeObserver(draw).observe(cv);
  setTimeout(draw, 0);
  return cv;
};

/* ---- server-side trim / crop / compress ---------------------------------- */
const editPanel = (e, mediaEl, host) => {
  const wrap = el('details', { class: 'card', style: 'padding:12px' });
  wrap.append(el('summary', { style: 'cursor:pointer;font-size:13px;color:var(--text-2)' },
    `${ic('scissors', 14)} Trim, crop &amp; compress`));
  const inner = el('div', { class: 'col', style: 'gap:12px;margin-top:12px' });
  wrap.append(inner);

  const timed = e.kind !== 'image' && e.durationMs > 0;
  const dur = e.durationMs || 0;
  let startMs = 0, endMs = dur;

  if (timed) {
    const readout = el('span', { class: 'mono dim', style: 'font-size:12px;min-width:104px;text-align:right' });
    const a = el('input', { type: 'range', min: 0, max: dur, value: 0, step: 100 });
    const b = el('input', { type: 'range', min: 0, max: dur, value: dur, step: 100 });
    const upd = () => {
      startMs = Math.min(+a.value, +b.value - 200);
      endMs = Math.max(+b.value, startMs + 200);
      a.value = startMs; b.value = endMs;
      readout.textContent = `${fmtDur(startMs)} – ${fmtDur(endMs)}`;
      if (mediaEl && mediaEl.currentTime != null) mediaEl.currentTime = startMs / 1000;
    };
    a.oninput = b.oninput = upd; upd();
    inner.append(el('div', { class: 'field' }, '<label>Trim</label>'));
    const r1 = el('div', { class: 'range' }); r1.append(el('span', { class: 'dim mono', style: 'font-size:11px' }, 'in'), a);
    const r2 = el('div', { class: 'range' }); r2.append(el('span', { class: 'dim mono', style: 'font-size:11px' }, 'out'), b, readout);
    inner.append(r1, r2);
  }

  let cropW = 0, cropH = 0, cropX = 0, cropY = 0;
  if (e.meta?.width && e.kind !== 'audio') {
    const W = e.meta.width, H = e.meta.height;
    const f = el('div', { class: 'field' }, '<label>Crop (pixels, blank = none)</label>');
    const g = el('div', { class: 'row' });
    const mk = (ph, v) => el('input', { class: 'input', type: 'number', min: 0, placeholder: ph, value: v ?? '', style: 'width:84px' });
    const ix = mk('x', 0), iy = mk('y', 0), iw = mk('w', W), ih = mk('h', H);
    const sync = () => { cropX = +ix.value || 0; cropY = +iy.value || 0;
      cropW = (+iw.value === W && +ih.value === H && !cropX && !cropY) ? 0 : (+iw.value || 0);
      cropH = cropW ? (+ih.value || 0) : 0; };
    [ix, iy, iw, ih].forEach(i => i.oninput = sync); sync();
    g.append(ix, iy, iw, ih);
    inner.append(f, g);
  }

  const maxW = el('select', { class: 'input' });
  [['0', 'Keep original size'], ['1920', 'Max width 1920'], ['1280', 'Max width 1280'], ['854', 'Max width 854'], ['640', 'Max width 640']]
    .forEach(([v, t]) => maxW.append(el('option', { value: v }, t)));
  const crf = el('select', { class: 'input' });
  [['0', 'Default quality'], ['20', 'High quality (larger)'], ['26', 'Balanced'], ['32', 'Small file']]
    .forEach(([v, t]) => crf.append(el('option', { value: v }, t)));
  inner.append(el('div', { class: 'field' }, '<label>Resolution</label>'), maxW,
               el('div', { class: 'field' }, '<label>Compression</label>'), crf);

  const keep = el('label', { class: 'row', style: 'font-size:12.5px;color:var(--text-2);cursor:pointer' });
  const keepBox = el('input', { type: 'checkbox' });
  keep.append(keepBox, el('span', {}, 'Keep the original file too'));
  inner.append(keep);

  const apply = el('button', { class: 'btn btn-primary' }, `${ic('zap', 15)}Apply on server`);
  const note = el('div', { class: 'dim', style: 'font-size:12px' },
    'Runs ffmpeg on the server and replaces this entry’s file.');
  inner.append(apply, note);

  apply.onclick = async () => {
    apply.disabled = true;
    const prev = apply.innerHTML;
    apply.innerHTML = '<span class="spin"></span>';
    try {
      const upd = await M.api.edit(e.id, {
        startMs: timed ? startMs : 0,
        endMs: timed && endMs < dur ? endMs : 0,
        cropX, cropY, cropW, cropH,
        maxW: +maxW.value, crf: +crf.value,
        keepOriginal: keepBox.checked,
      });
      M.store.upsert(upd); M.store.emit();
      toast(`Saved · ${fmtBytes(upd.size)}${upd.durationMs ? ' · ' + fmtDur(upd.durationMs) : ''}`);
      host.close?.();
      open(e.id);
    } catch (err) {
      toast(err.message, 'err');
      apply.disabled = false; apply.innerHTML = prev;
    }
  };
  return wrap;
};

M.viewer = { open };
})();
