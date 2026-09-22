/* App state + entry cache. Views subscribe and re-render on change. */
(() => {
const { debounce } = M.ui;

const KINDS = [
  { id: 'audio',    label: 'Audio',   icon: 'mic',      color: 'var(--audio)' },
  { id: 'video',    label: 'Video',   icon: 'video',    color: 'var(--video)' },
  { id: 'image',    label: 'Image',   icon: 'image',    color: 'var(--image)' },
  { id: 'markdown', label: 'Writing', icon: 'markdown', color: 'var(--markdown)' },
  { id: 'stroke',   label: 'Drawing', icon: 'stroke',   color: 'var(--stroke)' },
];
const kindOf = id => KINDS.find(k => k.id === id) || KINDS[0];

const state = {
  user: null,
  view: localStorage.getItem('memm.view') || 'timeline',
  kinds: new Set(JSON.parse(localStorage.getItem('memm.kinds') || 'null') || KINDS.map(k => k.id)),
  q: '',
  entries: new Map(),   // id -> entry
  loading: false,
};

const subs = new Set();
const on = fn => { subs.add(fn); return () => subs.delete(fn); };
const emit = () => subs.forEach(fn => fn(state));

const upsert = e => { state.entries.set(e.id, { ...state.entries.get(e.id), ...e }); };
const remove = id => state.entries.delete(id);

/* Entries overlapping [from,to], deduped into the cache. The server does the
   overlap query so a long recording stays visible when zoomed inside it. */
let seq = 0;
const load = async (from, to) => {
  const mine = ++seq;
  state.loading = true; emit();
  try {
    const { entries } = await M.api.list({
      from: from?.toISOString(), to: to?.toISOString(),
      kind: state.kinds.size === KINDS.length ? '' : [...state.kinds].join(','),
      q: state.q, limit: 600,
    });
    if (mine !== seq) return;           // a newer request already answered
    entries.forEach(upsert);
  } catch (err) {
    if (mine === seq) M.ui.toast(err.message, 'err');
  } finally {
    if (mine === seq) { state.loading = false; emit(); }
  }
};

const visible = () => [...state.entries.values()]
  .filter(e => state.kinds.has(e.kind))
  .sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt));

const setView = v => { state.view = v; localStorage.setItem('memm.view', v); emit(); };
const toggleKind = id => {
  state.kinds.has(id) ? state.kinds.delete(id) : state.kinds.add(id);
  if (!state.kinds.size) KINDS.forEach(k => state.kinds.add(k.id));
  localStorage.setItem('memm.kinds', JSON.stringify([...state.kinds]));
  emit();
};
const setQuery = debounce(q => {
  if (q === state.q) return;
  state.q = q;
  state.entries.clear();   // results are server-filtered; stale hits must go
  emit();
  M.app?.reload();
}, 260);

M.store = { KINDS, kindOf, state, on, emit, load, upsert, remove, visible, setView, toggleKind, setQuery };
})();
