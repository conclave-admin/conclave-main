function isValidTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isValidTimezone(timezone) {
  if (typeof timezone !== "string" || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function validateQuietHours(windows, timezone) {
  if (!Array.isArray(windows) || windows.length > 7) return false;
  if (!isValidTimezone(timezone)) return false;
  return windows.every((window) =>
    window &&
    typeof window === "object" &&
    Array.isArray(window.days) &&
    window.days.length > 0 &&
    window.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
    new Set(window.days).size === window.days.length &&
    isValidTime(window.start) &&
    isValidTime(window.end) &&
    window.start !== window.end
  );
}

function localClock(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: weekdays[values.weekday], minute: Number(values.hour) * 60 + Number(values.minute) };
}

function isQuietNow(windows = [], timezone = "UTC", now = new Date()) {
  if (!Array.isArray(windows) || !isValidTimezone(timezone)) return false;
  const { day, minute } = localClock(now, timezone);
  const previousDay = (day + 6) % 7;
  return windows.some((window) => {
    if (!window || typeof window !== "object") return false;
    const { days = [], start, end } = window;
    if (!Array.isArray(days) || !isValidTime(start) || !isValidTime(end) || start === end) return false;
    const startMinute = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
    const endMinute = Number(end.slice(0, 2)) * 60 + Number(end.slice(3));
    return startMinute < endMinute
      ? days.includes(day) && minute >= startMinute && minute < endMinute
      : (days.includes(day) && minute >= startMinute) ||
          (days.includes(previousDay) && minute < endMinute);
  });
}

module.exports = { isValidTimezone, validateQuietHours, isQuietNow };
