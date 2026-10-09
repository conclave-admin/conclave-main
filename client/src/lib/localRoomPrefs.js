const PINNED_KEY = 'conclave-pinned-rooms';
const MUTED_KEY = 'conclave-muted-rooms';

/**
 * Pin and mute, stored per browser.
 *
 * Deliberately local. Neither has a backend, so anything written here is this
 * device's opinion of the room rather than the workspace's — pin a room on a
 * laptop and the phone will not know. That is a real limitation and it is not
 * hidden: the state lives under these two keys and nowhere else, so when a
 * backend exists it replaces exactly this module.
 *
 * Reads are defensive because localStorage throws in private mode and can
 * hold a stale value of the wrong type after a format change. A corrupt entry
 * degrades to "nothing pinned", which is the correct default.
 *
 * @returns {string[]} room ids
 */
export function readIdList(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeIdList(key, ids) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Storage unavailable or full. The in-memory state still holds the change
    // for the life of the tab, which is the best that can be done without it.
  }
}

export function toggleId(list, id) {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

export const PINNED_ROOMS_KEY = PINNED_KEY;
export const MUTED_ROOMS_KEY = MUTED_KEY;
