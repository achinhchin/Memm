/* Live change feed. One account can record from several devices at once, so
   each device subscribes to the others' changes over Server-Sent Events.

   Uploads stay on ordinary HTTP requests: they are bulk, resumable byte
   ranges, and independent requests give parallelism, native Range semantics
   and per-chunk retry that a single socket would have to reimplement. Only
   the notifications need pushing, and EventSource reconnects on its own. */
(() => {
let src = null;

const connect = () => {
  if (src || typeof EventSource === 'undefined') return;
  src = new EventSource('/api/events', { withCredentials: true });

  src.addEventListener('entry', ev => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    const known = M.store.state.entries.get(e.id);
    // Events carry no text body, so keep whatever this device already has
    // rather than blanking a note that is open in the editor.
    if (known?.text && !e.text) e.text = known.text;
    M.store.upsert(e);
    M.store.emit();
  });

  src.addEventListener('delete', ev => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (M.store.state.entries.delete(d.id)) M.store.emit();
  });

  // EventSource retries on its own; nothing to do but let it.
  src.onerror = () => {};
};

const disconnect = () => { src?.close(); src = null; };

M.live = { connect, disconnect };
})();
