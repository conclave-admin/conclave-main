export function pushSupport(win = window) {
  return Boolean(
    win.isSecureContext &&
    win.Notification &&
    win.PushManager &&
    win.navigator.serviceWorker,
  );
}
export function applicationKey(value) {
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}

export function pushSupportHint(win = window) {
  if (!win.isSecureContext) return "Open Conclave over HTTPS to enable background notifications.";
  const nav = win.navigator;
  const appleMobile = /iPhone|iPad|iPod/.test(nav.userAgent || "") ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  const installed = nav.standalone === true ||
    win.matchMedia?.("(display-mode: standalone)")?.matches;
  if (appleMobile && !installed)
    return "On iPhone or iPad (iOS 16.4 or later), add Conclave to your Home Screen, open it there, then enable notifications in Settings.";
  return "Background notifications are unavailable in this browser. Try an updated browser and check your device notification settings.";
}
