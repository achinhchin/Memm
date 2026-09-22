/* List view: entries grouped by local day, newest first. */
(() => {
const { el, esc, fmtTime, fmtDur, fmtBytes, fmtDate, dayKey, offsetFor, debounce } = M.ui;
const { kindOf } = M.store;
const ic = M.icons;

M.list = { mount(root) {
  root.innerHTML = '';
  const scroller = el('div', { class: 'list' });
  root.append(scroller);

  const render = () => {
    const entries = M.store.visible();
    if (!entries.length) {
      scroller.innerHTML = `<div class="empty">${ic('inbox', 40)}
        <div><strong>Nothing here yet</strong><br>
        <span class="dim">Capture something with the dock below.</span></div></div>`;
      return;
    }
    const groups = new Map();
    for (const e of entries) {
      const k = dayKey(e.startsAt, offsetFor(e));
      (groups.get(k) || groups.set(k, []).get(k)).push(e);
    }
    scroller.innerHTML = '';
    for (const [day, items] of groups) {
      const sec = el('div', { class: 'day' });
      const total = items.reduce((a, e) => a + (e.durationMs || 0), 0);
      sec.append(el('div', { class: 'day-head' },
        `<h3>${esc(fmtDate(items[0].startsAt, offsetFor(items[0])))}</h3>
         <span>${items.length} ${items.length === 1 ? 'entry' : 'entries'}${total > 1000 ? ' · ' + fmtDur(total) : ''}</span>`));
      const grid = el('div', { class: 'items' });
      items.forEach(e => grid.append(card(e)));
      sec.append(grid);
      scroller.append(sec);
    }
  };

  const card = e => {
    const k = kindOf(e.kind), off = offsetFor(e);
    const n = el('div', { class: 'card item', tabindex: '0', style: `--k:${k.color};--k-soft:color-mix(in srgb,${k.color} 16%,transparent)` });
    const thumb = el('div', { class: 'thumb' });
    if (e.thumb) thumb.append(el('img', { src: M.api.blobURL(e.thumb, 'image/jpeg'), alt: '', loading: 'lazy', decoding: 'async' }));
    else if (e.peaks?.length) {
      const w = el('div', { class: 'wave' });
      const step = Math.ceil(e.peaks.length / 14);
      for (let i = 0; i < e.peaks.length; i += step) w.append(el('i', { style: `height:${Math.max(6, e.peaks[i] * 100)}%` }));
      thumb.append(w);
    } else thumb.innerHTML = ic(k.icon, 20);

    const dur = e.durationMs > 1000 ? ` · ${fmtDur(e.durationMs)}` : '';
    const size = e.size ? ` · ${fmtBytes(e.size)}` : '';
    const tz = M.ui.captureTZ ? ` ${M.ui.fmtTZ(e.tzOffset)}` : '';
    const meta = el('div', { class: 'grow' }, `
      <h4 class="truncate">${esc(e.title || k.label)}</h4>
      <div class="sub">${fmtTime(e.startsAt, off)}${tz}${dur}${size}</div>
      ${e.text ? `<div class="snippet">${esc(e.text.replace(/[#*`>_]/g, '').slice(0, 140))}</div>` : ''}
      ${e.status === 'recording' ? '<div class="sub" style="color:var(--danger)">recording…</div>' : ''}`);
    n.append(thumb, meta);
    const open = () => M.viewer.open(e.id);
    n.onclick = open;
    n.onkeydown = ev => { if (ev.key === 'Enter') open(); };
    return n;
  };

  /* Paging: when the user nears the bottom, widen the loaded window backwards. */
  let oldest = null;
  const more = debounce(() => {
    const es = M.store.visible();
    if (!es.length) return;
    const last = +new Date(es[es.length - 1].startsAt);
    if (oldest === last) return;
    oldest = last;
    M.store.load(new Date(last - 60 * 864e5), new Date(last));
  }, 200);
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 400) more();
  });

  M.store.load(new Date(Date.now() - 30 * 864e5), new Date(Date.now() + 864e5));
  render();
  return { render, destroy() {} };
}};
})();
