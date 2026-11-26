import test from "node:test";
import assert from "node:assert/strict";
import { playNotificationSound } from "../src/lib/notificationSound.js";

// The alert sound is non-essential: browsers with no Web Audio, or a page
// that has not yet had a user gesture (autoplay policy), must get silence
// rather than a thrown error inside the socket event handler.
test("playNotificationSound is silent rather than throwing without Web Audio", () => {
  const previous = globalThis.window;
  globalThis.window = {};
  try {
    assert.doesNotThrow(() => playNotificationSound());
  } finally {
    globalThis.window = previous;
  }
});

test("playNotificationSound schedules two tones on a fresh AudioContext", () => {
  const started = [];
  class FakeOscillator {
    constructor() {
      this.frequency = { value: 0 };
      this.type = "sine";
    }
    connect(node) {
      return node;
    }
    start(at) {
      started.push(at);
    }
    stop() {}
  }
  class FakeGain {
    connect() {
      return this;
    }
    gain = {
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {},
    };
  }
  class FakeContext {
    state = "running";
    currentTime = 1;
    destination = {};
    createOscillator() {
      return new FakeOscillator();
    }
    createGain() {
      return new FakeGain();
    }
    resume() {
      return Promise.resolve();
    }
  }
  const previous = globalThis.window;
  globalThis.window = { AudioContext: FakeContext };
  try {
    playNotificationSound();
    // Two notes, and the second starts after the first ends rather than at
    // the same instant — that offset is what makes it read as a "ding".
    assert.equal(started.length, 2);
    assert.ok(started[1] > started[0]);
  } finally {
    globalThis.window = previous;
  }
});
