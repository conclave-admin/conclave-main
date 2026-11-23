export function waveformPeaks(samples, count = 48) {
  if (!samples?.length) return Array(count).fill(0);
  const result = Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * samples.length) / count);
    const end = Math.max(
      start + 1,
      Math.floor(((index + 1) * samples.length) / count),
    );
    const stride = Math.max(1, Math.floor((end - start) / 512));
    let peak = 0;
    for (let i = start; i < end; i += stride)
      peak = Math.max(peak, Math.abs(samples[i] || 0));
    return peak;
  });
  const max = Math.max(...result, 0.01);
  return result.map((value) => value / max);
}
export function recordingGesture(dx, dy) {
  if (dx < -80 && Math.abs(dx) > Math.abs(dy)) return "cancel";
  if (dy < -70) return "lock";
  return "hold";
}
