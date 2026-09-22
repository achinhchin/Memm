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

  const mime = wantVideo
    ? pickMime(['video/mp4;codecs=avc1', 'video/webm;codecs=vp9,opus', 'video/webm'])
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

  /* HUD */
  const pill = el('div', { class: 'rec glass' });
  const time = el('span', { class: 't' }, '0:00');
  const lvl = el('div', { class: 'lvl' });
  for (let i = 0; i < 7; i++) lvl.append(el('i'));
  const stop = el('button', { class: 'btn btn-danger btn-icon', title: 'Stop recording' }, ic('stop', 15));
  pill.append(el('span', { class: 'blip' }), time, lvl, stop);
  document.body.append(pill);

  let preview = null;
  if (wantVideo) {
    preview = el('video', { autoplay: '', muted: '', playsinline: '',
      style: 'position:fixed;right:14px;top:calc(var(--nav-h) + 14px);width:200px;border-radius:12px;z-index:50;box-shadow:var(--shadow);transform:scaleX(-1)' });
    preview.srcObject = stream;
    document.body.append(preview);
  }

  /* mic level meter */
  let ac, raf;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const an = ac.createAnalyser(); an.fftSize = 256;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const bars = [...lvl.children];
    const loop = () => {
      an.getByteFrequencyData(buf);
      const band = Math.floor(buf.length / bars.length);
      bars.forEach((b, i) => {
        let s = 0; for (let j = 0; j < band; j++) s += buf[i * band + j];
        b.style.height = Math.max(10, Math.min(100, (s / band) / 1.4)) + '%';
      });
      raf = requestAnimationFrame(loop);
    };
    loop();
  } catch {}

  const t = setInterval(() => { time.textContent = fmtDur(Date.now() - +startedAt); }, 500);

  const finish = async () => {
    stop.disabled = true;
    stop.innerHTML = '<span class="spin"></span>';
    clearInterval(t); cancelAnimationFrame(raf); ac?.close().catch(() => {});
    if (rec.state !== 'inactive') {
      await new Promise(res => { rec.onstop = res; rec.stop(); });
    }
    stream.getTracks().forEach(x => x.stop());
    preview?.remove();
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
      toast(`${wantVideo ? 'Video' : 'Audio'} saved · ${fmtDur(done.durationMs)} · ${fmtBytes(done.size)}`);
      M.viewer.open(done.id);
    } catch (e) {
      toast('Upload failed: ' + e.message, 'err');
    } finally { pill.remove(); }
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

/* ---- stroke pad ---------------------------------------------------------- */
const PENS = ['#e6e9ee', '#6f8fd6', '#7fb3a6', '#c2a173', '#b58aa8', '#c97b7b'];

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

  // Strokes are stored in normalized 0..1 coordinates so a note drawn on a
  // phone replays correctly on a desktop canvas.
  let strokes = [];
  try { strokes = JSON.parse(entry.text || '[]'); } catch {}

  const body = el('div', { class: 'col', style: 'gap:10px' });
  const titleIn = el('input', { class: 'input', placeholder: 'Title', value: entry.title || '' });
  const pad = el('canvas', { class: 'pad' });
  const tools = el('div', { class: 'pen-row' });
  let color = PENS[0], width = 3;

  PENS.forEach((c, i) => {
    const s = el('button', { class: 'swatch', style: `background:${c}`, 'aria-pressed': i === 0, 'aria-label': 'Pen colour' });
    s.onclick = () => { color = c; [...tools.querySelectorAll('.swatch')].forEach(x => x.ariaPressed = 'false'); s.ariaPressed = 'true'; };
    tools.append(s);
  });
  const widthIn = el('input', { type: 'range', min: 1, max: 14, value: 3, style: 'width:100px' });
  widthIn.oninput = () => { width = +widthIn.value; };
  const undo = el('button', { class: 'btn btn-sm' }, 'Undo');
  const clear = el('button', { class: 'btn btn-sm btn-danger' }, 'Clear');
  tools.append(el('div', { class: 'grow' }), widthIn, undo, clear);
  body.append(titleIn, pad, tools);

  const ctx = pad.getContext('2d');
  const fit = () => {
    const r = pad.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  };
  const redraw = () => {
    const r = pad.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.strokeStyle = s.c; ctx.lineWidth = s.w;
      ctx.beginPath();
      for (let i = 0; i < s.p.length; i += 2) {
        const x = s.p[i] * r.width, y = s.p[i + 1] * r.height;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  };

  let cur = null;
  const pt = ev => { const r = pad.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height]; };
  pad.addEventListener('pointerdown', ev => {
    pad.setPointerCapture(ev.pointerId);
    cur = { c: color, w: width, p: pt(ev) };
    strokes.push(cur);
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
    status.textContent = 'Saving…';
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
  fit();
}

M.capture = { record, importImage, uploadImage, writeMarkdown, drawStroke, Uploader,
  start(kind) {
    if (kind === 'audio' || kind === 'video') return record(kind);
    if (kind === 'image') return importImage();
    if (kind === 'markdown') return writeMarkdown();
    if (kind === 'stroke') return drawStroke();
  } };
})();
