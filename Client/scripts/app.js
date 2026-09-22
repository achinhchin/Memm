/* Shell: nav, filters, capture dock, view switching, bootstrap. */
(() => {
const { el, esc, $, modal, toast, fmtTZ } = M.ui;
const { KINDS, state } = M.store;
const ic = M.icons;
const root = $('#app');

let current = null;   // active view controller

const boot = async () => {
  root.className = 'app-boot';
  root.innerHTML = '<span class="spin"></span>';
  try {
    const user = await M.api.me();
    start(user);
  } catch {
    M.auth.mount(root, start);
  }
};

const start = user => {
  state.user = user;
  render();
};

const render = () => {
  root.className = 'shell';
  root.innerHTML = '';

  /* ---- nav ---- */
  const nav = el('nav', { class: 'nav' });
  nav.append(el('div', { class: 'brand' }, `${ic('memm', 20)}<span>Memm</span>`));

  const seg = el('div', { class: 'seg', role: 'tablist' });
  const mkTab = (id, icon, label) => {
    const b = el('button', { role: 'tab', 'aria-selected': state.view === id, title: label },
      `${ic(icon, 15)}<span>${label}</span>`);
    b.onclick = () => { M.store.setView(id); mount(); [...seg.children].forEach(c => c.ariaSelected = c === b); };
    return b;
  };
  seg.append(mkTab('timeline', 'timeline', 'Timeline'), mkTab('list', 'list', 'List'));
  nav.append(seg, el('div', { class: 'nav-spacer' }));

  const search = el('div', { class: 'search' }, ic('search', 15));
  const searchIn = el('input', { class: 'input', type: 'search', placeholder: 'Search', value: state.q });
  searchIn.oninput = () => M.store.setQuery(searchIn.value);
  search.append(searchIn);
  nav.append(search);

  const acct = el('button', { class: 'btn btn-ghost btn-icon', title: state.user.username }, ic('user', 17));
  acct.onclick = account;
  nav.append(acct);

  /* ---- filters ---- */
  const filters = el('div', { class: 'filters' });
  KINDS.forEach(k => {
    const c = el('button', { class: 'chip', 'aria-pressed': state.kinds.has(k.id),
      style: `--k:${k.color};--k-soft:color-mix(in srgb,${k.color} 18%,transparent)` },
      `<span class="dot"></span>${k.label}`);
    c.onclick = () => { M.store.toggleKind(k.id); c.ariaPressed = state.kinds.has(k.id); refresh(); };
    filters.append(c);
  });
  filters.append(el('div', { class: 'grow' }));

  // Cross-country journalling: read times either on your clock or on the
  // clock of wherever each entry was captured.
  const tzChip = el('button', { class: 'chip', 'aria-pressed': M.ui.captureTZ },
    `${ic('clock', 13)}${M.ui.captureTZ ? 'Capture time' : 'My time ' + fmtTZ(M.ui.localOffset())}`);
  tzChip.onclick = () => {
    M.ui.captureTZ = !M.ui.captureTZ;
    localStorage.setItem('memm.tz', M.ui.captureTZ ? '1' : '0');
    render();
  };
  filters.append(tzChip);

  /* ---- main ---- */
  const main = el('div', { class: 'main' });

  /* ---- dock ---- */
  root._dock?.remove();          // the dock lives on <body>, not in root
  const dock = el('div', { class: 'dock' });
  KINDS.forEach(k => {
    const b = el('button', { 'data-kind': k.id, title: `New ${k.label.toLowerCase()}`, 'aria-label': `New ${k.label}` }, ic(k.icon, 19));
    b.onclick = () => M.capture.start(k.id);
    dock.append(b);
  });

  root.append(nav, filters, main);
  document.body.append(dock);
  root._dock = dock;

  mount(main);
};

const mount = container => {
  const main = container || $('.main', root);
  current?.destroy?.();
  current = (state.view === 'timeline' ? M.timeline : M.list).mount(main);
};

const refresh = () => M.app.reload();

const account = () => {
  const out = el('button', { class: 'btn btn-danger' }, `${ic('logout', 15)}Sign out`);
  const body = el('div', { class: 'col', style: 'gap:12px' });
  body.innerHTML = `
    <div class="meta-grid card" style="padding:12px">
      <dt>Username</dt><dd>${esc(state.user.username)}</dd>
      <dt>Time zone</dt><dd>${fmtTZ(M.ui.localOffset())}</dd>
      <dt>Entries loaded</dt><dd>${state.entries.size}</dd>
    </div>
    <p class="dim" style="font-size:12px">Shortcuts: drag to pan · scroll to zoom · +/− zoom · F fit · Esc close</p>`;
  const stats = el('div', { class: 'col', style: 'gap:6px' });
  body.append(stats);
  M.api.stats().then(({ kinds }) => {
    if (!kinds?.length) return;
    stats.innerHTML = '<div class="meta-grid card" style="padding:12px">' + kinds.map(r =>
      `<dt>${esc(M.store.kindOf(r._id).label)}</dt><dd>${r.count} · ${M.ui.fmtBytes(r.bytes || 0)}</dd>`).join('') + '</div>';
  }).catch(() => {});
  const m = modal({ title: 'Account', body, foot: [out] });
  out.onclick = async () => {
    try { await M.api.logout(); } catch {}
    m.close();
    root._dock?.remove();
    state.entries.clear(); state.user = null;
    current?.destroy?.(); current = null;
    boot();
  };
};

M.app = {
  refresh,
  reload() {
    if (state.view === 'list') M.store.load(new Date(Date.now() - 30 * 864e5), new Date(Date.now() + 864e5));
    else current?.render?.();
  },
};

M.ui.captureTZ = localStorage.getItem('memm.tz') === '1';
M.store.on(() => current?.render?.());
boot();
})();
