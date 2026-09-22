/* DOM helpers, formatting, toasts, modals, markdown. */
(() => {
const ic = M.icons;

const el = (tag, attrs = {}, html) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---- time ---------------------------------------------------------------
   Everything on the wire is a UTC instant. `tzOffset` (minutes east of UTC)
   says which wall clock the entry was captured on, so a trip abroad still
   reads back at the hour it felt like. The app toggles between the viewer's
   zone and each entry's own capture zone.                                  */
const MIN = 6e4;
let useCaptureTZ = false;
const localOffset = () => -new Date().getTimezoneOffset();
const offsetFor = e => (useCaptureTZ && e && typeof e.tzOffset === 'number' ? e.tzOffset : localOffset());
// Shift an instant so UTC getters read as wall-clock in the target offset.
const shifted = (iso, off) => new Date(new Date(iso).getTime() + off * MIN);
const pad = n => String(n).padStart(2, '0');
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const fmtTZ = off => `UTC${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
const fmtTime = (iso, off = localOffset()) => { const d = shifted(iso, off); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const fmtDate = (iso, off = localOffset()) => { const d = shifted(iso, off); return `${DAY[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const fmtFull = (iso, off = localOffset()) => `${fmtDate(iso, off)} ${fmtTime(iso, off)}`;
const dayKey = (iso, off = localOffset()) => shifted(iso, off).toISOString().slice(0, 10);

const fmtDur = ms => {
  if (!ms || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};
const fmtBytes = b => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtSpan = ms => {
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  if (s < 5184000) return `${Math.round(s / 86400)}d`;
  if (s < 63072000) return `${Math.round(s / 2592000)}mo`;
  return `${(s / 31536000).toFixed(1)}y`;
};

/* ---- toasts ------------------------------------------------------------- */
const toast = (msg, kind = 'ok') => {
  const n = el('div', { class: `toast glass ${kind}` },
    `${ic(kind === 'err' ? 'alert' : 'check', 16)}<span>${esc(msg)}</span>`);
  $('#toasts').append(n);
  setTimeout(() => {
    n.style.transition = 'opacity .24s, transform .24s';
    n.style.opacity = 0; n.style.transform = 'translateX(16px)';
    setTimeout(() => n.remove(), 260);
  }, kind === 'err' ? 4200 : 2400);
};

/* ---- modal -------------------------------------------------------------- */
let openModals = 0;
const modal = ({ title, body, foot, wide, onClose }) => {
  const scrim = el('div', { class: 'scrim' });
  const box = el('div', { class: 'modal glass' });
  if (wide) box.style.width = 'min(920px,100%)';
  const head = el('div', { class: 'modal-head' }, `<h2 class="grow truncate">${esc(title)}</h2>`);
  const close = el('button', { class: 'btn btn-ghost btn-icon', 'aria-label': 'Close' }, ic('x', 17));
  head.append(close);
  const bodyEl = el('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  box.append(head, bodyEl);
  if (foot) { const f = el('div', { class: 'modal-foot' }); f.append(...foot); box.append(f); }
  scrim.append(box);

  const dismiss = () => {
    scrim.remove(); openModals--;
    document.removeEventListener('keydown', onKey);
    if (!openModals) document.body.style.overflow = '';
    onClose?.();
  };
  const onKey = e => { if (e.key === 'Escape' && openModals) dismiss(); };
  close.onclick = dismiss;
  scrim.onclick = e => { if (e.target === scrim) dismiss(); };
  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
  openModals++;
  $('#layer').append(scrim);
  setTimeout(() => bodyEl.querySelector('input,textarea,button')?.focus(), 60);
  return { scrim, box, body: bodyEl, close: dismiss };
};

const confirm = (title, msg, danger = true) => new Promise(res => {
  const no = el('button', { class: 'btn' }, 'Cancel');
  const yes = el('button', { class: danger ? 'btn btn-danger' : 'btn btn-primary' }, 'Confirm');
  const m = modal({ title, body: `<p class="muted">${esc(msg)}</p>`, foot: [no, yes], onClose: () => res(false) });
  no.onclick = () => m.close();
  yes.onclick = () => { m.close(); res(true); };
});

/* ---- tiny markdown ------------------------------------------------------
   Deliberately small: headings, emphasis, code, lists, quotes, links. All
   input is escaped first, so no raw HTML can reach the page.              */
const md = src => {
  const lines = esc(src || '').split('\n');
  let out = '', inCode = false, listType = null;
  const closeList = () => { if (listType) { out += `</${listType}>`; listType = null; } };
  const inline = s => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  for (const ln of lines) {
    if (/^```/.test(ln)) { closeList(); out += inCode ? '</code></pre>' : '<pre><code>'; inCode = !inCode; continue; }
    if (inCode) { out += ln + '\n'; continue; }
    let m;
    if ((m = ln.match(/^(#{1,3})\s+(.*)/))) { closeList(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
    else if ((m = ln.match(/^\s*[-*]\s+(.*)/))) { if (listType !== 'ul') { closeList(); out += '<ul>'; listType = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = ln.match(/^\s*\d+\.\s+(.*)/))) { if (listType !== 'ol') { closeList(); out += '<ol>'; listType = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = ln.match(/^>\s?(.*)/))) { closeList(); out += `<blockquote>${inline(m[1])}</blockquote>`; }
    else if (!ln.trim()) closeList();
    else { closeList(); out += `<p>${inline(ln)}</p>`; }
  }
  closeList();
  if (inCode) out += '</code></pre>';
  return out;
};

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

M.ui = { el, esc, $, $$, toast, modal, confirm, md, debounce,
  fmtTime, fmtDate, fmtFull, fmtDur, fmtBytes, fmtSpan, fmtTZ, dayKey, shifted, localOffset, offsetFor, MIN,
  get captureTZ() { return useCaptureTZ; }, set captureTZ(v) { useCaptureTZ = v; } };
})();
