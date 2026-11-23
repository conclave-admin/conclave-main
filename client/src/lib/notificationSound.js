// A short, synthesized two-tone "ding" for an in-app new-message alert.
// Generated with Web Audio rather than shipping an audio asset: it is a few
// lines instead of a licensed sound file, scales to any volume/sample rate,
// and has no network/caching concerns. Browsers require a prior user gesture
// before audio can play; this fails silently when that has not happened yet,
// which is the correct outcome for a non-essential alert sound.
let ctx;

function context() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx) ctx = new Ctx();
  return ctx;
}

export function playNotificationSound() {
  try {
    const audio = context();
    if (!audio) return;
    if (audio.state === "suspended") audio.resume().catch(() => {});
    const now = audio.currentTime;
    [[880, now, 0.09], [1175, now + 0.09, 0.12]].forEach(
      ([frequency, start, duration]) => {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.02);
      },
    );
  } catch {
    // Non-essential; a silent alert is strictly better than a thrown error.
  }
}
