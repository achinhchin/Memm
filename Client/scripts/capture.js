/* Capture: live audio/video recording with streaming upload, image import
   with client-side compression, markdown autosave and a stroke pad. */
(() => {
const { el, esc, $, modal, toast, fmtDur, fmtBytes, debounce, md } = M.ui;
const ic = M.icons;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- chunked uploader ----------------------------------------------------
   Slices are pushed as they arrive and drained in order. The server is the
   source of truth for the byte offset, so a retry after a dropped connection
   resumes exactly where it left off instead of duplicating audio.         */
class Uploader {
  constructor(id, onProgress) { this.id = id; this.onProgress = onProgress;
    this.offset = 0; this.queue = []; this.busy = false; this.failed = null; }
  push(blob) { if (blob?.size) { this.queue.push(blob); this.pump(); } }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const blob = this.queue[0];
      let attempt = 0;
      for (;;) {
        try {
          this.offset = await M.api.chunk(this.id, blob, this.offset);
          this.queue.shift();
          this.onProgress?.(this.offset);
          break;
        } catch (err) {
          if (err.mismatch) {
            // The server already holds this slice (a retry that did land).
            if (err.serverOffset >= this.offset + blob.size) {
              this.offset = err.serverOffset; this.queue.shift(); break;
            }
            this.offset = err.serverOffset;
            continue;
          }
          if (++attempt > 5) { this.failed = err; this.queue.shift(); break; }
          await sleep(300 * attempt);
        }
      }
      if (this.failed) break;
    }
    this.busy = false;
  }
  async drain() {
    while (this.queue.length || this.busy) await sleep(60);
    if (this.failed) throw this.failed;
    return this.offset;
  }
}

const pickMime = cands => cands.find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';

/* ---- live audio / video -------------------------------------------------- */
async function record(kind) {
  const wantVideo = kind === 'video';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: wantVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
    });
  } catch (e) {
    return toast(e.name === 'NotAllowedError' ? 'Microphone/camera permission denied' : e.message, 'err');
  }

  // Every video candidate names an AUDIO codec alongside the video one. A
  // string like 'video/mp4;codecs=avc1' is accepted by isTypeSupported but
  // records picture only, which is how sound went missing from clips: the
  // camera track and the microphone track belong in one file, not two.
  const mime = wantVideo
    ? pickMime([
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=h264,aac',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4',
      ])
    : pickMime(['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']);

  const startedAt = new Date();
  let entry;
  try {
    entry = await M.api.create({
      kind, mime, startsAt: startedAt.toISOString(), endsAt: startedAt.toISOString(),
      tzOffset: M.ui.localOffset(), title: '',
    });
  } catch (e) { stream.getTracks().forEach(t => t.stop()); return toast(e.message, 'err'); }

  M.store.upsert(entry); M.store.emit();

  const up = new Uploader(entry.id);
  const rec = new MediaRecorder(stream, {
    mimeType: mime || undefined,
    videoBitsPerSecond: wantVideo ? 2_500_000 : undefined,
    audioBitsPerSecond: 128_000,
  });
  rec.ondataavailable = ev => up.push(ev.data);
  rec.start(2000);   // a slice every 2s: small enough to stream, few enough requests

  /* overlay: preview + level metering */
  const pill = el('div', { class: 'rec glass' });
  const time = el('span', { class: 't' }, '0:00');
  const meter = el('div', { class: 'meter' });
  const meterFill = el('i', { class: 'fill' });
  const meterPeak = el('i', { class: 'peak' });
  meter.append(meterFill, meterPeak);
  const dbRead = el('span', { class: 'db mono' }, '-\u221e dB');
  const advice = el('span', { class: 'advice' }, '');
  const stop = el('button', { class: 'btn btn-danger btn-icon', title: 'Stop recording' }, ic('stop', 15));
  pill.append(el('span', { class: 'blip' }), time, meter, dbRead, advice, stop);

  let preview = null, shell = null;
  if (wantVideo) {
    // A real preview, sized to the viewport, so framing is checkable on a
    // phone as well as a desktop.
    shell = el('div', { class: 'rec-stage' });
    preview = el('video', { autoplay: true, muted: true, playsinline: true, class: 'rec-video' });
    preview.srcObject = stream;
    preview.muted = true;                  // property, not just the attribute
    shell.append(preview, pill);
    document.body.append(shell);
  } else {
    document.body.append(pill);
  }

  /* Level metering. RMS drives the bar and the dB readout; a separate peak
     detector catches the brief transients that actually cause clipping. */
  let ac, raf, peakHold = 0, peakAt = 0, clipped = false;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.3;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0, peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        sum += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / buf.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

      // -60dB..0dB mapped across the bar.
      const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
      meterFill.style.width = pct + '%';
      meterFill.style.background = db > -3 ? 'var(--danger)' : db > -12 ? 'var(--image)' : 'var(--ok)';

      const now = performance.now();
      if (peak >= peakHold || now - peakAt > 900) { peakHold = peak; peakAt = now; }
      const peakDb = peakHold > 0 ? 20 * Math.log10(peakHold) : -Infinity;
      meterPeak.style.left = Math.max(0, Math.min(100, ((peakDb + 60) / 60) * 100)) + '%';

      if (peak >= 0.99) clipped = true;
      dbRead.textContent = db === -Infinity ? '-\u221e dB' : db.toFixed(0) + ' dB';
      advice.textContent = peak >= 0.99 ? 'clipping' : db < -45 ? 'too quiet' : '';
      advice.className = 'advice' + (peak >= 0.99 ? ' bad' : db < -45 ? ' warn' : '');
      raf = requestAnimationFrame(loop);
    };
    loop();
  } catch {}

  const t = setInterval(() => { time.textContent = fmtDur(Date.now() - +startedAt); }, 500);

  const finish = async () => {
    stop.disabled = true;
    stop.innerHTML = '<span class="spin"></span>';
    clearInterval(t); cancelAnimationFrame(raf); ac?.close?.().catch?.(() => {});
    if (rec.state !== 'inactive') {
      await new Promise(res => { rec.onstop = res; rec.stop(); });
    }
    stream.getTracks().forEach(x => x.stop());
    if (preview) preview.srcObject = null;
    shell?.remove();
    try {
      await up.drain();
      const done = await M.api.finish(entry.id, {
        mime, endsAt: new Date().toISOString(),
        // Server-side shrink only when the browser could not encode
        // efficiently itself (no MP4/VP9 support means a bulky container).
        compress: wantVideo && !mime.includes('avc1') && !mime.includes('vp9'),
        maxW: 1280, crf: 26,
      });
      M.store.upsert(done); M.store.emit();
      toast(`${wantVideo ? 'Video' : 'Audio'} saved · ${fmtDur(done.durationMs)} · ${fmtBytes(done.size)}` +
            (clipped ? ' · input clipped' : ''), clipped ? 'err' : 'ok');
      M.viewer.open(done.id);
    } catch (e) {
      toast('Upload failed: ' + e.message, 'err');
    } finally { pill.remove(); shell?.remove(); }
  };

  stop.onclick = finish;
  rec.onerror = e => { toast('Recorder error: ' + e.error?.name, 'err'); finish(); };
}

/* ---- image --------------------------------------------------------------- */
function importImage() {
  const input = el('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden' });
  document.body.append(input);
  input.onchange = async () => {
    const files = [...input.files]; input.remove();
    for (const f of files) await uploadImage(f);
  };
  input.click();
}

/* Downscale and re-encode in the browser first; the server only re-encodes
   when the canvas path is unavailable. */
async function shrink(file, maxDim = 2560, quality = 0.86) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return { blob: file, mime: file.type };
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (s === 1 && file.size < 900_000) { bmp.close?.(); return { blob: file, mime: file.type }; }
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob = await cv.convertToBlob({ type: 'image/jpeg', quality });
    return blob.size < file.size ? { blob, mime: 'image/jpeg' } : { blob: file, mime: file.type };
  } catch { return { blob: file, mime: file.type }; }
}

async function uploadImage(file) {
  // Prefer the capture time baked into the file over the moment of upload.
  const at = new Date(file.lastModified || Date.now());
  const { blob, mime } = await shrink(file);
  let entry;
  try {
    entry = await M.api.create({
      kind: 'image', mime, title: file.name.replace(/\.[^.]+$/, ''),
      startsAt: at.toISOString(), endsAt: at.toISOString(), tzOffset: M.ui.localOffset(),
    });
  } catch (e) { return toast(e.message, 'err'); }

  const up = new Uploader(entry.id);
  // Slice large images so a flaky link can resume instead of restarting.
  const CH = 4 << 20;
  for (let o = 0; o < blob.size; o += CH) up.push(blob.slice(o, o + CH));
  try {
    await up.drain();
    const done = await M.api.finish(entry.id, { mime, compress: blob === file, maxW: 2560 });
    M.store.upsert(done); M.store.emit();
    toast(`Image saved · ${fmtBytes(done.size)}`);
  } catch (e) { toast('Upload failed: ' + e.message, 'err'); }
}

/* ---- markdown ------------------------------------------------------------ */
async function writeMarkdown(existing) {
  let entry = existing;
  if (!entry) {
    const now = new Date().toISOString();
    try {
      entry = await M.api.create({ kind: 'markdown', title: '', text: '',
        startsAt: now, endsAt: now, tzOffset: M.ui.localOffset() });
    } catch (e) { return toast(e.message, 'err'); }
    M.store.upsert(entry); M.store.emit();
  }

  const body = el('div', { class: 'col', style: 'gap:12px' });
  const titleIn = el('input', { class: 'input', placeholder: 'Title', value: entry.title || '' });
  const tabs = el('div', { class: 'tabs' });
  const tWrite = el('button', { 'aria-selected': 'true' }, 'Write');
  const tPreview = el('button', { 'aria-selected': 'false' }, 'Preview');
  tabs.append(tWrite, tPreview);
  const area = el('textarea', { class: 'textarea', placeholder: '# Today\n\nWhat happened…', style: 'min-height:46dvh' });
  area.value = entry.text || '';
  const prev = el('div', { class: 'md-preview hidden', style: 'min-height:46dvh' });
  const status = el('span', { class: 'dim', style: 'font-size:12px' }, 'Saved');
  body.append(titleIn, tabs, area, prev);

  tWrite.onclick = () => { tWrite.ariaSelected = 'true'; tPreview.ariaSelected = 'false'; area.classList.remove('hidden'); prev.classList.add('hidden'); area.focus(); };
  tPreview.onclick = () => { tWrite.ariaSelected = 'false'; tPreview.ariaSelected = 'true'; prev.innerHTML = md(area.value); area.classList.add('hidden'); prev.classList.remove('hidden'); };

  const save = async () => {
    status.textContent = 'Saving…';
    try {
      await M.api.saveText(entry.id, { text: area.value, endsAt: new Date().toISOString() });
      if (titleIn.value !== entry.title) { entry = await M.api.patch(entry.id, { title: titleIn.value }); }
      const fresh = await M.api.get(entry.id);
      M.store.upsert(fresh); M.store.emit();
      status.textContent = 'Saved ' + M.ui.fmtTime(new Date().toISOString());
    } catch (e) { status.textContent = 'Save failed'; toast(e.message, 'err'); }
  };
  const auto = debounce(save, 900);
  area.oninput = titleIn.oninput = auto;

  const done = el('button', { class: 'btn btn-primary' }, 'Done');
  const m = modal({ title: existing ? 'Edit note' : 'New note', body, wide: true,
    foot: [status, el('div', { class: 'grow' }), done], onClose: save });
  done.onclick = async () => { await save(); m.close(); };
}

/* ---- stroke pad ----------------------------------------------------------
   Five pen slots, each carrying its own colour and width, plus an eraser with
   a width of its own. Slots persist, so a pen set up once stays set up.     */
const DEFAULT_PENS = [
  { c: '#e6e9ee', w: 3 },
  { c: '#6f8fd6', w: 5 },
  { c: '#7fb3a6', w: 2 },
  { c: '#c2a173', w: 8 },
  { c: '#b58aa8', w: 14 },
];
const loadPens = () => {
  try {
    const v = JSON.parse(localStorage.getItem('memm.pens') || 'null');
    if (Array.isArray(v) && v.length === 5) return v.map((p, i) => ({ ...DEFAULT_PENS[i], ...p }));
  } catch {}
  return DEFAULT_PENS.map(p => ({ ...p }));
};
const savePens = (pens, eraserW) => {
  localStorage.setItem('memm.pens', JSON.stringify(pens));
  localStorage.setItem('memm.eraser', String(eraserW));
};

async function drawStroke(existing) {
  let entry = existing;
  if (!entry) {
    const now = new Date().toISOString();
    try {
      entry = await M.api.create({ kind: 'stroke', title: '', text: '[]',
        startsAt: now, endsAt: now, tzOffset: M.ui.localOffset() });
    } catch (e) { return toast(e.message, 'err'); }
    M.store.upsert(entry); M.store.emit();
  }

  // Strokes are stored in normalised 0..1 coordinates so a note drawn on a
  // phone replays correctly on a desktop canvas. An erase stroke is an
  // ordinary stroke flagged with e:1 and composited as destination-out, which
  // keeps the whole drawing a replayable vector list.
  let strokes = [];
  try { strokes = JSON.parse(entry.text || '[]'); } catch {}

  const pens = loadPens();
  let eraserW = Number(localStorage.getItem('memm.eraser')) || 18;
  let slot = 0, erasing = false;

  const body = el('div', { class: 'col', style: 'gap:10px' });
  const titleIn = el('input', { class: 'input', placeholder: 'Title', value: entry.title || '' });
  const pad = el('canvas', { class: 'pad' });

  const slots = el('div', { class: 'pen-slots' });
  const eraserBtn = el('button', { class: 'pen-slot eraser', title: 'Eraser', 'aria-pressed': false },
    ic('stroke', 15));
  const editor = el('div', { class: 'pen-editor' });
  const colorIn = el('input', { type: 'color', class: 'pen-color', 'aria-label': 'Pen colour' });
  const sizeIn = el('input', { type: 'range', min: 1, max: 48, step: 1, class: 'pen-size', 'aria-label': 'Size' });
  const sizeOut = el('span', { class: 'mono dim pen-size-out' });
  const dot = el('span', { class: 'pen-preview' });

  const current = () => (erasing ? { c: '#ffffff', w: eraserW } : pens[slot]);
  const syncEditor = () => {
    const cur = current();
    colorIn.value = cur.c;
    colorIn.disabled = erasing;          // an eraser has no colour to pick
    sizeIn.value = cur.w;
    sizeOut.textContent = cur.w + ' px';
    dot.style.width = dot.style.height = Math.max(4, Math.min(30, cur.w)) + 'px';
    dot.style.background = erasing ? 'var(--line)' : cur.c;
    dot.style.borderStyle = erasing ? 'dashed' : 'solid';
    slots.querySelectorAll('.pen-slot').forEach((b, i) => b.setAttribute('aria-pressed', String(!erasing && i === slot)));
    eraserBtn.setAttribute('aria-pressed', String(erasing));
  };

  pens.forEach((p, i) => {
    const b = el('button', { class: 'pen-slot', 'aria-pressed': i === 0, title: `Pen ${i + 1}` });
    const swatch = el('span', { class: 'pen-dot' });
    b.append(swatch);
    b.onclick = () => { erasing = false; slot = i; syncEditor(); };
    slots.append(b);
  });
  slots.append(eraserBtn);
  eraserBtn.onclick = () => { erasing = true; syncEditor(); };

  const paintSlots = () => slots.querySelectorAll('.pen-dot').forEach((d, i) => {
    d.style.background = pens[i].c;
    d.style.width = d.style.height = Math.max(6, Math.min(22, pens[i].w)) + 'px';
  });

  colorIn.oninput = () => { if (!erasing) { pens[slot].c = colorIn.value; paintSlots(); syncEditor(); savePens(pens, eraserW); } };
  sizeIn.oninput = () => {
    const w = +sizeIn.value;
    if (erasing) eraserW = w; else pens[slot].w = w;
    paintSlots(); syncEditor(); savePens(pens, eraserW);
  };

  editor.append(dot, colorIn, sizeIn, sizeOut);

  const undo = el('button', { class: 'btn btn-sm' }, 'Undo');
  const clear = el('button', { class: 'btn btn-sm btn-danger' }, 'Clear');
  const actions = el('div', { class: 'pen-actions' });
  actions.append(undo, clear);

  const tools = el('div', { class: 'pen-row' });
  tools.append(slots, editor, actions);
  body.append(titleIn, pad, tools);

  const ctx = pad.getContext('2d');
  const fit = () => {
    const r = pad.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    if (!r.width) return;
    pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  };
  const redraw = () => {
    const r = pad.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const st of strokes) {
      ctx.globalCompositeOperation = st.e ? 'destination-out' : 'source-over';
      ctx.strokeStyle = st.c; ctx.lineWidth = st.w;
      ctx.beginPath();
      for (let i = 0; i < st.p.length; i += 2) {
        const x = st.p[i] * r.width, y = st.p[i + 1] * r.height;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      // A single tap has no second point, so stroke() alone draws nothing.
      if (st.p.length === 2) ctx.lineTo(st.p[0] * r.width + 0.01, st.p[1] * r.height);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  };

  let cur = null;
  const pt = ev => { const r = pad.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height]; };
  pad.addEventListener('pointerdown', ev => {
    pad.setPointerCapture(ev.pointerId);
    const c = current();
    cur = erasing ? { c: c.c, w: c.w, e: 1, p: pt(ev) } : { c: c.c, w: c.w, p: pt(ev) };
    strokes.push(cur);
    redraw();
  });
  pad.addEventListener('pointermove', ev => {
    if (!cur) return;
    // Coalesced events keep fast strokes smooth on high-rate styluses.
    for (const e2 of (ev.getCoalescedEvents?.() || [ev])) cur.p.push(...pt(e2));
    redraw();
  });
  const end = () => { if (cur) { cur = null; auto(); } };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);

  undo.onclick = () => { strokes.pop(); redraw(); auto(); };
  clear.onclick = () => { strokes = []; redraw(); auto(); };

  const status = el('span', { class: 'dim', style: 'font-size:12px' }, 'Saved');
  const save = async () => {
    status.textContent = 'Saving\u2026';
    try {
      await M.api.saveText(entry.id, { text: JSON.stringify(strokes), endsAt: new Date().toISOString() });
      if (titleIn.value !== entry.title) await M.api.patch(entry.id, { title: titleIn.value });
      const fresh = await M.api.get(entry.id);
      M.store.upsert(fresh); M.store.emit();
      status.textContent = 'Saved';
    } catch (e) { status.textContent = 'Save failed'; toast(e.message, 'err'); }
  };
  const auto = debounce(save, 900);
  titleIn.oninput = auto;

  const done = el('button', { class: 'btn btn-primary' }, 'Done');
  const m = modal({ title: existing ? 'Edit drawing' : 'New drawing', body, wide: true,
    foot: [status, el('div', { class: 'grow' }), done], onClose: () => { ro.disconnect(); save(); } });
  done.onclick = async () => { await save(); m.close(); };
  const ro = new ResizeObserver(fit); ro.observe(pad);
  paintSlots(); syncEditor(); fit();
}

M.capture = { record, importImage, uploadImage, writeMarkdown, drawStroke, Uploader,
  start(kind) {
    if (kind === 'audio' || kind === 'video') return record(kind);
    if (kind === 'image') return importImage();
    if (kind === 'markdown') return writeMarkdown();
    if (kind === 'stroke') return drawStroke();
  } };
})();
