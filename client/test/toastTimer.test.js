import test from 'node:test';
import assert from 'node:assert/strict';
import { createToastTimer } from '../src/lib/toastTimer.js';

function fixture() {
  let now = 0, next = 0, dismissed = 0;
  const pending = new Map();
  const clock = {
    now: () => now,
    set: (callback, delay) => { const id = ++next; pending.set(id, { callback, due: now + delay }); return id; },
    clear: id => pending.delete(id),
  };
  const timer = createToastTimer(() => dismissed++, 5000, clock);
  return { timer, get dismissed() { return dismissed; }, advance(ms) { now += ms; for (const [id, task] of pending) if (task.due <= now) { pending.delete(id); task.callback(); } } };
}

test('hover pauses dismissal and resumes only the remaining duration', () => {
  const f = fixture();
  f.advance(2000); f.timer.pause('hover'); f.advance(10000);
  assert.equal(f.dismissed, 0);
  f.timer.resume('hover'); f.advance(2999);
  assert.equal(f.dismissed, 0);
  f.advance(1); assert.equal(f.dismissed, 1);
});

test('overlapping hover and keyboard focus must both end before dismissal resumes', () => {
  const f = fixture();
  f.advance(1000); f.timer.pause('focus'); f.timer.pause('hover');
  f.timer.resume('hover'); f.advance(10000);
  assert.equal(f.dismissed, 0);
  f.timer.resume('focus'); f.advance(4000);
  assert.equal(f.dismissed, 1);
});

test('dismissal or unmount cancels paused and running timers', () => {
  for (const paused of [false, true]) {
    const f = fixture();
    if (paused) f.timer.pause('focus');
    f.timer.dispose(); f.timer.resume('focus'); f.advance(10000);
    assert.equal(f.dismissed, 0);
  }
});
