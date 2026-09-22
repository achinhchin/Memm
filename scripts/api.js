/* Thin fetch wrapper. Session lives in an httpOnly cookie, so requests only
   need credentials:'same-origin'. */
(() => {
const json = async (method, path, body, opts = {}) => {
  const r = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
  });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json().catch(() => ({})) : null;
  if (!r.ok) throw Object.assign(new Error(data?.error || `${r.status} ${r.statusText}`), { status: r.status, data });
  return data;
};

const qs = o => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

M.api = {
  signup: c => json('POST', '/api/auth/signup', c),
  login:  c => json('POST', '/api/auth/login', c),
  logout: () => json('POST', '/api/auth/logout'),
  me:     () => json('GET', '/api/auth/me'),

  list:   q => json('GET', '/api/entries' + qs(q)),
  create: e => json('POST', '/api/entries', e),
  get:    id => json('GET', `/api/entries/${id}`),
  patch:  (id, p) => json('PATCH', `/api/entries/${id}`, p),
  del:    id => json('DELETE', `/api/entries/${id}`),
  stats:  () => json('GET', '/api/stats'),

  offset: id => json('GET', `/api/entries/${id}/offset`),
  finish: (id, p) => json('POST', `/api/entries/${id}/finish`, p || {}),
  saveText: (id, p) => json('PUT', `/api/entries/${id}/text`, p),
  edit:   (id, p) => json('POST', `/api/entries/${id}/edit`, p),

  /* Append one buffered slice of a live capture. The server echoes the byte
     offset it now holds; on a mismatch it returns 409 with the true offset so
     the caller can re-slice rather than corrupt the file. */
  async chunk(id, blob, offset) {
    const r = await fetch(`/api/entries/${id}/chunk`, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Offset': String(offset) },
      body: blob,
    });
    if (r.status === 409) {
      const err = new Error('offset mismatch');
      err.serverOffset = Number(r.headers.get('X-Offset') || 0);
      err.mismatch = true;
      throw err;
    }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `upload failed (${r.status})`);
    return (await r.json()).offset;
  },

  blobURL: (hash, mime) => `/api/blob/${hash}${mime ? '?mime=' + encodeURIComponent(mime) : ''}`,
};
})();
