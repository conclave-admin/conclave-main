const KEY = 'conclave-media-preferences';
const DEFAULTS = { video: false, documents: false, network: 'any', respectSaveData: true };
export function getMediaPreferences() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return DEFAULTS; }
}
export function saveMediaPreferences(value) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, ...value }));
    window.dispatchEvent(new Event('conclave:media-preferences')); } catch { /* device storage can be disabled */ }
}
export function networkSnapshot(connection = globalThis.navigator?.connection) {
  return { type: connection?.type || 'unknown', effectiveType: connection?.effectiveType || 'unknown', saveData: Boolean(connection?.saveData) };
}
export function allowsAutomaticDownload(preferences, network, online = true) {
  if (!online || (preferences.respectSaveData !== false && network.saveData)) return false;
  if (preferences.network === 'unmetered') return ['wifi', 'ethernet'].includes(network.type);
  if (preferences.network === 'fast') return network.effectiveType === '4g';
  return preferences.network === undefined || preferences.network === 'any';
}
