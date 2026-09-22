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

/* Advanced filters. `from`/`to` are a hard date range the user asked for; the
   timeline's viewport window is intersected with it, so a range set here
   constrains both views identically. */
const blankFilters = () => ({ from: null, to: null, minMs: 0, maxMs: 0, tags: [], status: '' });
const savedFilters = () => {
  try { return { ...blankFilters(), ...JSON.parse(localStorage.getItem('memm.filters') || '{}') }; }
  catch { return blankFilters(); }
};

const state = {
  user: null,
  view: localStorage.getItem('memm.view') || 'timeline',
  kinds: new Set(JSON.parse(localStorage.getItem('memm.kinds') || 'null') || KINDS.map(k => k.id)),
  q: '',
  filters: savedFilters(),
  entries: new Map(),   // id -> entry
  loading: false,
};

const saveFilters = () => localStorage.setItem('memm.filters', JSON.stringify(state.filters));
const setFilters = patch => {
  Object.assign(state.filters, patch);
  saveFilters();
  state.entries.clear();     // the server applies these, so cached rows are stale
  emit();
  M.app?.reload();
};
const clearFilters = () => setFilters(blankFilters());
// How many filters are narrowing the view, for the badge on the filter button.
const activeFilterCount = () => {
  const f = state.filters;
  return [f.from, f.to, f.minMs, f.maxMs, f.tags.length, f.status].filter(Boolean).length
       + (state.kinds.size < KINDS.length ? 1 : 0)
       + (state.q ? 1 : 0);
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
  const f = state.filters;
  // Intersect the requested window with the user's hard date range.
  const lo = f.from ? new Date(Math.max(+new Date(f.from), from ? +from : -8.64e15)) : from;
  const hi = f.to ? new Date(Math.min(+new Date(f.to), to ? +to : 8.64e15)) : to;
  if (lo && hi && lo >= hi) { state.loading = false; emit(); return; }
  state.loading = true; emit();
  try {
    const { entries } = await M.api.list({
      from: lo?.toISOString(), to: hi?.toISOString(),
      kind: state.kinds.size === KINDS.length ? '' : [...state.kinds].join(','),
      q: state.q, limit: 600,
      minMs: f.minMs || '', maxMs: f.maxMs || '',
      tag: f.tags.join(','), status: f.status,
    });
    if (mine !== seq) return;           // a newer request already answered
    entries.forEach(upsert);
  } catch (err) {
    if (mine === seq) M.ui.toast(err.message, 'err');
  } finally {
    if (mine === seq) { state.loading = false; emit(); }
  }
};

/* Mirrors the server's filters over the local cache: an entry that arrives by
   another route (a live update, an edit) must not slip past a narrowed view. */
const matches = e => {
  const f = state.filters;
  if (!state.kinds.has(e.kind)) return false;
  if (f.from && new Date(e.endsAt) < new Date(f.from)) return false;
  if (f.to && new Date(e.startsAt) > new Date(f.to)) return false;
  if (f.minMs && (e.durationMs || 0) < f.minMs) return false;
  if (f.maxMs && (e.durationMs || 0) > f.maxMs) return false;
  if (f.status && e.status !== f.status) return false;
  if (f.tags.length && !f.tags.some(t => (e.tags || []).some(x => x.toLowerCase() === t.toLowerCase()))) return false;
  if (state.q) {
    const hay = `${e.title || ''} ${(e.tags || []).join(' ')} ${e.text || ''}`.toLowerCase();
    if (!hay.includes(state.q.toLowerCase())) return false;
  }
  return true;
};

const visible = () => [...state.entries.values()]
  .filter(matches)
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

M.store = { KINDS, kindOf, state, on, emit, load, upsert, remove, visible, matches,
  setView, toggleKind, setQuery, setFilters, clearFilters, blankFilters, activeFilterCount };
})();
