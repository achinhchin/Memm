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
  M.live.connect();     // pick up changes made on this account's other devices
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
  const kindChips = KINDS.map(k => {
    const c = el('button', { class: 'chip', 'aria-pressed': state.kinds.has(k.id),
      style: `--k:${k.color};--k-soft:color-mix(in srgb,${k.color} 18%,transparent)` },
      `<span class="dot"></span>${k.label}`);
    c.onclick = () => { M.store.toggleKind(k.id); syncChips(); refresh(); };
    filters.append(c);
    return c;
  });
  // Deselecting the last kind re-enables all of them, so every chip has to be
  // refreshed from state rather than just the one that was clicked.
  const syncChips = () => {
    kindChips.forEach((c, i) => c.setAttribute('aria-pressed', String(state.kinds.has(KINDS[i].id))));
    advBtn.setAttribute('data-n', String(M.store.activeFilterCount()));
    advBtn.classList.toggle('on', M.store.activeFilterCount() > 0);
  };

  const advBtn = el('button', { class: 'chip adv', title: 'Advanced filters' },
    `${ic('filter', 13)}Filters`);
  advBtn.onclick = () => advancedPanel(syncChips);
  filters.append(advBtn, el('div', { class: 'grow' }));

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
  syncChips();

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

/* Advanced filter + search, shared by both views. Date range, duration, tags,
   status and free text all narrow the same query the server already runs. */
const advancedPanel = onApply => {
  const f = { ...state.filters, tags: [...state.filters.tags] };
  const body = el('div', { class: 'col', style: 'gap:14px' });

  const field = (label, ...kids) => {
    const w = el('div', { class: 'field' }, `<label>${esc(label)}</label>`);
    const row = el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' });
    row.append(...kids); w.append(row); return w;
  };
  // <input type=datetime-local> wants a local wall-clock string, not an ISO
  // instant, so convert in both directions.
  const toLocalInput = iso => {
    if (!iso) return '';
    const d = new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 6e4);
    return d.toISOString().slice(0, 16);
  };
  const fromLocalInput = v => (v ? new Date(v).toISOString() : null);

  const fromIn = el('input', { class: 'input', type: 'datetime-local', value: toLocalInput(f.from) });
  const toIn = el('input', { class: 'input', type: 'datetime-local', value: toLocalInput(f.to) });
  body.append(field('Date range', fromIn, toIn));

  const presets = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' });
  const DAY = 864e5;
  [['Today', 0], ['7 days', 7], ['30 days', 30], ['This year', -1], ['All time', null]].forEach(([label, n]) => {
    const b = el('button', { class: 'chip' }, label);
    b.onclick = () => {
      if (n === null) { fromIn.value = ''; toIn.value = ''; return; }
      const now = new Date();
      let start;
      if (n === -1) start = new Date(now.getFullYear(), 0, 1);
      else if (n === 0) start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else start = new Date(Date.now() - n * DAY);
      fromIn.value = toLocalInput(start.toISOString());
      toIn.value = '';
    };
    presets.append(b);
  });
  body.append(presets);

  const minIn = el('input', { class: 'input', type: 'number', min: 0, placeholder: 'min', style: 'width:96px',
    value: f.minMs ? Math.round(f.minMs / 1000) : '' });
  const maxIn = el('input', { class: 'input', type: 'number', min: 0, placeholder: 'max', style: 'width:96px',
    value: f.maxMs ? Math.round(f.maxMs / 1000) : '' });
  body.append(field('Duration (seconds)', minIn, el('span', { class: 'dim' }, 'to'), maxIn));

  const tagsIn = el('input', { class: 'input', placeholder: 'any of these tags, comma separated', value: f.tags.join(', ') });
  body.append(field('Tags', tagsIn));

  const statusSel = el('select', { class: 'input' });
  [['', 'Any status'], ['ready', 'Ready'], ['recording', 'Still recording'], ['failed', 'Failed']]
    .forEach(([v, t]) => {
      const o = el('option', { value: v }, t);
      if (v === f.status) o.setAttribute('selected', '');
      statusSel.append(o);
    });
  statusSel.value = f.status || '';
  body.append(field('Status', statusSel));

  const qIn = el('input', { class: 'input', type: 'search', placeholder: 'words in a title, tag or note', value: state.q });
  body.append(field('Text', qIn));

  const kindRow = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' });
  KINDS.forEach(k => {
    const c = el('button', { class: 'chip', 'aria-pressed': state.kinds.has(k.id),
      style: `--k:${k.color};--k-soft:color-mix(in srgb,${k.color} 18%,transparent)` },
      `<span class="dot"></span>${k.label}`);
    c.onclick = () => { M.store.toggleKind(k.id); c.setAttribute('aria-pressed', String(state.kinds.has(k.id))); };
    kindRow.append(c);
  });
  body.append(field('Kinds', kindRow));

  const reset = el('button', { class: 'btn btn-ghost' }, 'Reset');
  const apply = el('button', { class: 'btn btn-primary' }, 'Apply');
  const m = modal({ title: 'Filters', body, foot: [reset, el('div', { class: 'grow' }), apply] });

  reset.onclick = () => {
    KINDS.forEach(k => state.kinds.add(k.id));
    localStorage.setItem('memm.kinds', JSON.stringify([...state.kinds]));
    state.q = '';
    M.store.clearFilters();
    m.close(); render();
  };
  apply.onclick = () => {
    const secs = v => (v === '' || isNaN(+v) ? 0 : Math.max(0, Math.round(+v * 1000)));
    state.q = qIn.value.trim();
    M.store.setFilters({
      from: fromLocalInput(fromIn.value),
      to: fromLocalInput(toIn.value),
      minMs: secs(minIn.value),
      maxMs: secs(maxIn.value),
      tags: tagsIn.value.split(',').map(t => t.trim()).filter(Boolean),
      status: statusSel.value,
    });
    m.close();
    onApply?.();
    // A hard date range is also where the user wants to be looking.
    if (state.view === 'timeline') current?.fit?.();
  };
};

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
    M.live.disconnect();
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
