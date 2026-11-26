const KEY = "conclave-media-preferences";
const DEFAULTS = {
  images: true,
  audio: true,
  video: true,
  documents: true,
  // Background transfers can be large and mobile browsers often run on
  // metered plans. Keep automatic downloads on Wi-Fi/Ethernet by default;
  // users can opt into cellular data from Settings.
  network: "unmetered",
  networkExplicit: false,
  respectSaveData: true,
};
export function getMediaPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    const preferences = { ...DEFAULTS, ...saved };
    // Before Wi-Fi-first became the default, "any" was also the default.
    // Migrate that legacy implicit value, but preserve an explicit choice
    // recorded by current versions.
    if (saved.network === "any" && saved.networkExplicit !== true)
      preferences.network = DEFAULTS.network;
    return preferences;
  } catch {
    return DEFAULTS;
  }
}
export function saveMediaPreferences(value) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, ...value }));
    window.dispatchEvent(new Event("conclave:media-preferences"));
  } catch {
    /* device storage can be disabled */
  }
}
export function networkSnapshot(connection = globalThis.navigator?.connection) {
  return {
    type: connection?.type || "unknown",
    effectiveType: connection?.effectiveType || "unknown",
    saveData: Boolean(connection?.saveData),
  };
}
export function allowsAutomaticDownload(preferences, network, online = true) {
  if (!online || (preferences.respectSaveData !== false && network.saveData))
    return false;
  if (preferences.network === "unmetered")
    return ["wifi", "ethernet"].includes(network.type);
  if (preferences.network === "fast") return network.effectiveType === "4g";
  return preferences.network === undefined || preferences.network === "any";
}

export function automaticMediaType(attachment, preferences) {
  const type = attachment.mime_type || "";
  return Boolean(
    preferences[
      type.startsWith("image/")
        ? "images"
        : type.startsWith("video/")
          ? "video"
          : type.startsWith("audio/")
            ? "audio"
            : "documents"
    ],
  );
}
