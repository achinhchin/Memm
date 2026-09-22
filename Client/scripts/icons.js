/* Inline stroke icons (Lucide geometry). No emoji, no icon-font request. */
window.M = window.M || {};
M.icons = (() => {
  const p = {
    memm:'M12 3v18M5 8v8M19 8v8M8.5 5.5v13M15.5 5.5v13',
    timeline:'M3 6h18M3 12h12M3 18h7M7 4v4M15 10v4M9 16v4',
    list:'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    mic:'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
    video:'M16 10.5 22 7v10l-6-3.5M2 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z',
    image:'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
    markdown:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4',
    stroke:'M12 19l7-7a2.83 2.83 0 0 0-4-4l-7 7-2 6z M16 6l2 2',
    search:'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.3-4.3',
    x:'M18 6 6 18M6 6l12 12',
    check:'M20 6 9 17l-5-5',
    alert:'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    plus:'M12 5v14M5 12h14',
    minus:'M5 12h14',
    trash:'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6',
    stop:'M6 6h12v12H6z',
    save:'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
    logout:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    user:'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    clock:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    scissors:'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
    crop:'M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2',
    zap:'M4 14h7l-2 8 11-12h-7l2-8z',
    download:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    filter:'M22 3H2l8 9.5V19l4 2v-8.5z',
    calendar:'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    inbox:'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13a2 2 0 0 1 1.8 1.1l3.2 5.9v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.2-5.9A2 2 0 0 1 5.5 5z',
    focus:'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2',
    upload:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  };
  return (name, size = 18, cls = '') => {
    const d = p[name]; if (!d) return '';
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">${d.split(' M').map((s,i)=>`<path d="${i?'M'+s:s}"/>`).join('')}</svg>`;
  };
})();
