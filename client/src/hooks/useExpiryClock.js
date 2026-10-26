import { useEffect, useState } from "react";
// Wake only at the next expiry, including when a sleeping tab resumes.
export default function useExpiryClock(messages = []) {
  const [now, setNow] = useState(Date.now);
  const next = messages.reduce((soon, m) => {
    const time = new Date(m?.expires_at).getTime();
    return time > Date.now() ? Math.min(soon, time) : soon;
  }, Infinity);
  useEffect(() => {
    const wake = () => setNow(Date.now());
    const timer = Number.isFinite(next)
      ? setTimeout(
          wake,
          Math.min(2147483647, Math.max(0, next - Date.now()) + 20),
        )
      : null;
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [next, now]);
  return now;
}
