// Multiple interaction sources may overlap (keyboard focus and pointer hover).
export function createToastTimer(onDismiss, duration, clock = {
  now: () => performance.now(),
  set: (callback, delay) => window.setTimeout(callback, delay),
  clear: (id) => window.clearTimeout(id),
}) {
  let remaining = duration;
  let started = clock.now();
  let disposed = false;
  const paused = new Set();
  const fire = () => {
    disposed = true;
    onDismiss();
  };
  let timer = clock.set(fire, remaining);
  return {
    pause(reason) {
      if (disposed || paused.has(reason)) return;
      if (!paused.size) {
        remaining = Math.max(0, remaining - (clock.now() - started));
        clock.clear(timer);
      }
      paused.add(reason);
    },
    resume(reason) {
      if (disposed || !paused.delete(reason) || paused.size) return;
      started = clock.now();
      timer = clock.set(fire, remaining);
    },
    dispose() {
      disposed = true;
      clock.clear(timer);
    },
  };
}
