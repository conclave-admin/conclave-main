import { useEffect, useRef, useState } from "react";
import { waveformPeaks } from "../../lib/waveform";

let decodeQueue = Promise.resolve();
const peakCache = new WeakMap();
function decodeWaveform(blob, Context, active) {
  const job = decodeQueue
    .catch(() => {})
    .then(async () => {
      if (!active()) return null;
      if (peakCache.has(blob)) return peakCache.get(blob);
      let context;
      try {
        context = new Context();
        const decoded = await context.decodeAudioData(await blob.arrayBuffer());
        const peaks = waveformPeaks(decoded.getChannelData(0));
        peakCache.set(blob, peaks);
        return peaks;
      } finally {
        await context?.close().catch(() => {});
      }
    });
  decodeQueue = job.catch(() => {});
  return job;
}

export function LiveRecordingWaveform({ stream, paused }) {
  const [levels, setLevels] = useState(() => Array(24).fill(0));
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => setElapsed((value) => value + 0.25), 250);
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    let context, source, analyser;
    try {
      if (AudioContext && stream) {
        context = new AudioContext();
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        context.resume().catch(() => {});
      }
    } catch {
      /* Recording remains available without visualisation support. */
    }
    const samples = new Float32Array(1024);
    const wave = setInterval(() => {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 5);
      setLevels((values) => [...values.slice(1), level]);
    }, 80);
    return () => {
      clearInterval(timer);
      clearInterval(wave);
      source?.disconnect();
      context?.close().catch(() => {});
    };
  }, [stream, paused]);
  return (
    <div
      role="group"
      className="flex min-w-0 flex-1 items-center gap-3"
      aria-label={paused ? "Recording paused" : "Recording voice note"}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${paused ? "bg-muted" : "bg-error"}`}
        aria-hidden="true"
      />
      <time className="min-w-10 text-xs tabular-nums text-ink">
        {Math.floor(elapsed / 60)}:
        {String(Math.floor(elapsed % 60)).padStart(2, "0")}
      </time>
      <div className="audio-waveform min-w-0 flex-1" aria-hidden="true">
        {levels.map((level, i) => (
          <span key={i} style={{ height: `${Math.max(8, level * 100)}%` }} />
        ))}
      </div>
    </div>
  );
}
export default function AudioWaveform({
  blob,
  duration,
  currentTime,
  onSeek,
  disabled,
  label,
}) {
  const [peaks, setPeaks] = useState(() => Array(48).fill(0));
  const root = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!window.IntersectionObserver) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "150px" },
    );
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    setPeaks(Array(48).fill(0));
    if (
      !visible ||
      !blob ||
      blob.size > 5 * 1024 * 1024 ||
      !duration ||
      duration > 300
    )
      return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    decodeWaveform(blob, Context, () => active)
      .then((values) => {
        if (active && values) setPeaks(values);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [blob, duration, visible]);
  const progress = duration ? currentTime / duration : 0;
  return (
    <div ref={root} className="relative h-11 min-w-0">
      <div
        className="audio-waveform pointer-events-none h-full"
        aria-hidden="true"
      >
        {peaks.map((peak, index) => (
          <span
            key={index}
            className={
              index / peaks.length <= progress && currentTime > 0
                ? "text-brand"
                : "text-muted/35"
            }
            style={{ height: `${Math.max(10, peak * 85)}%` }}
          />
        ))}
      </div>
      <input
        type="range"
        min="0"
        max={duration || 1}
        step="0.1"
        value={Math.min(currentTime, duration || 1)}
        onChange={onSeek}
        disabled={disabled}
        aria-label={`Seek ${label}`}
        aria-valuetext={`${Math.floor(currentTime)} of ${Math.floor(duration || 0)} seconds`}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 focus:opacity-100 disabled:cursor-default"
      />
    </div>
  );
}
