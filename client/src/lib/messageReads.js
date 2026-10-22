export function activeReadView(doc = document, win = window) {
  return doc.visibilityState === 'visible' && doc.hasFocus() && win.navigator.onLine !== false && !doc.querySelector?.('[role="dialog"][aria-modal="true"]');
}
export function messageIsVisible(node, container, win = window) {
  const box = node.getBoundingClientRect(); const root = container.getBoundingClientRect();
  const top = Math.max(root.top, 0); const bottom = Math.min(root.bottom, win.innerHeight);
  const left = Math.max(root.left, 0); const right = Math.min(root.right, win.innerWidth);
  const height = Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top));
  return box.height > 0 && bottom > top && box.right > left && box.left < right &&
    height >= Math.min(box.height, bottom - top) * 0.55;
}

// Geometry is re-read on resume: IntersectionObserver need not fire when a
// tab returns with the same intersection. Only successful acks are remembered.
export function observeMessageReads({ container, messages, confirmed, inFlight = new Set(), onRead, enabled = true, doc = document, win = window }) {
  const pending = inFlight; let disposed = false; let retry;
  const scan = () => {
    if (disposed || !enabled || !activeReadView(doc, win)) return;
    for (const node of container.querySelectorAll('[data-message-id]')) {
      const id = node.getAttribute('data-message-id'); const message = messages.get(id);
      if (!message || confirmed.has(id) || pending.has(id) || !messageIsVisible(node, container, win)) continue;
      pending.add(id);
      Promise.resolve().then(() => {
        if (disposed || !activeReadView(doc, win) || !messageIsVisible(node, container, win)) return false;
        return onRead(message);
      }).then(accepted => { if (accepted === true) confirmed.add(id); }).catch(() => {}).finally(() => {
        pending.delete(id);
        if (disposed) win.dispatchEvent(new Event('conclave:read-resume'));
        if (!disposed && !confirmed.has(id) && !retry) retry = win.setTimeout(() => { retry = null; scan(); }, 1500);
      });
    }
  };
  const observer = typeof win.IntersectionObserver === 'function' ? new win.IntersectionObserver(scan, { root: container, threshold: [0, 0.55, 1] }) : null;
  container.querySelectorAll('[data-message-id]').forEach(node => observer?.observe(node));
  const events = ['focus', 'pageshow', 'online', 'resize', 'conclave:read-resume'];
  for (const event of events) win.addEventListener(event, scan);
  doc.addEventListener('visibilitychange', scan); doc.addEventListener('focusin', scan); container.addEventListener('scroll', scan, { passive: true });
  scan();
  return () => {
    disposed = true; observer?.disconnect(); if (retry) win.clearTimeout(retry);
    for (const event of events) win.removeEventListener(event, scan);
    doc.removeEventListener('visibilitychange', scan); doc.removeEventListener('focusin', scan); container.removeEventListener('scroll', scan);
  };
}
