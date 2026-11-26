function validTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validTimezone(timezone) {
  try {
    return typeof timezone === "string" && !!new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    return false;
  }
}

export function isQuietNow(windows = [], timezone = "UTC", now = new Date()) {
  if (!Array.isArray(windows) || !validTimezone(timezone)) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = weekdays[values.weekday];
  const minute = Number(values.hour) * 60 + Number(values.minute);
  return windows.some((window) => {
    if (!window || typeof window !== "object") return false;
    const { days = [], start, end } = window;
    if (!Array.isArray(days) || !validTime(start) || !validTime(end) || start === end) return false;
    const first = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
    const last = Number(end.slice(0, 2)) * 60 + Number(end.slice(3));
    return first < last
      ? days.includes(day) && minute >= first && minute < last
      : (days.includes(day) && minute >= first) ||
          (days.includes((day + 6) % 7) && minute < last);
  });
}
