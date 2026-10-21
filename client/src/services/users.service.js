import { api } from '../lib/api';
import { isDevAuthBypass, previewPreferences, previewRooms, previewUser, previewUsers } from '../config/devPreview';

/**
 * The people directory and the signed-in user's own account.
 *
 * Search goes through `/users/search` rather than `/users`. Both list people,
 * but `/users` returns every user's `email` to any authenticated caller, which
 * is fine for an admin directory and wrong for the compose and add-member
 * pickers — those would become a way to read the workspace's address book. The
 * dedicated endpoint matches on email but never returns one.
 */

export async function searchUsers(term) {
  const q = (term || '').trim();
  if (isDevAuthBypass) {
    if (!q) return [];
    const needle = q.toLowerCase();
    return previewUsers.filter(
      (person) => person.display_name.toLowerCase().includes(needle),
    );
  }
  const { data } = await api.get('/users/search', { params: { q } });
  return data.data.users;
}

/**
 * PATCH /users/me. Whitelist-only server-side: display_name, avatar_url, bio.
 * Passing anything else is silently ignored rather than rejected, so an empty
 * response change here usually means a field name typo.
 */
export async function updateProfile(updates) {
  if (isDevAuthBypass) {
    Object.assign(previewUser, updates);
    return { ...previewUser };
  }
  const { data } = await api.patch('/users/me', updates);
  return data.data;
}

/**
 * Upload an image and return its URL, for use as avatar_url.
 *
 * `uploadFile` is the same function the composer uses for attachments — there is
 * no separate avatar endpoint, and there should not be one: it is one upload
 * endpoint with an allowlist of types, and an avatar is a file like any other.
 *
 * The returned URL is not the avatar yet. The caller still has to PATCH it, which
 * is why this does not return the user.
 */
export async function uploadAvatar(file) {
  if (isDevAuthBypass) return URL.createObjectURL(file);
  const { data } = await api.post('/upload', uploadForm(file));
  return data.data.url;
}

const resolvedAvatarUrls = new Map();

/** Turn an opaque R2 avatar key into a short-lived image URL for <img>. */
export async function resolveAvatarUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('r2://')) return value || null;

  const cached = resolvedAvatarUrls.get(value);
  if (cached?.expiresAt > Date.now() / 1000 + 60) return cached.url;
  if (cached?.promise) return cached.promise;

  const promise = api.get('/users/avatar-url', { params: { url: value } })
    .then(({ data }) => {
      const result = data.data;
      resolvedAvatarUrls.set(value, { url: result.url, expiresAt: result.expiresAt });
      return result.url;
    })
    .catch((error) => {
      resolvedAvatarUrls.delete(value);
      throw error;
    });
  resolvedAvatarUrls.set(value, { promise });
  return promise;
}

// axios sets the multipart boundary itself. Setting content-type by hand here is
// the classic way to produce a request the server cannot parse, and the failure
// surfaces as "No file provided" rather than as anything about headers.
function uploadForm(file) {
  const form = new FormData();
  form.append('file', file);
  return form;
}

/**
 * DELETE /users/me — a soft delete. It nulls the email, blanks the password,
 * renames the account to "Deleted user" and drops every room membership, but it
 * keeps messages and decisions. There is no undo and no re-registration of the
 * same address, so callers must confirm first.
 */
export async function deleteAccount() {
  if (isDevAuthBypass) return { message: 'Account deleted' };
  const { data } = await api.delete('/users/me');
  return data.data;
}

export async function getPreferences() {
  if (isDevAuthBypass) return { ...previewPreferences };
  const { data } = await api.get('/users/me/preferences');
  return data.data;
}

export async function updatePreferences(updates) {
  if (isDevAuthBypass) {
    Object.assign(previewPreferences, updates);
    return { ...previewPreferences };
  }
  const { data } = await api.patch('/users/me/preferences', updates);
  return data.data;
}

export async function getSharedRooms(userId) {
  if (isDevAuthBypass) {
    return previewRooms.filter((room) => room.type !== 'dm' && room.members?.some((m) => m.id === userId));
  }
  const { data } = await api.get(`/users/${userId}/shared-rooms`);
  return data.data.rooms;
}

export async function reportUser(userId, payload) {
  if (isDevAuthBypass) return { id: `report-${Date.now()}`, status: 'open' };
  const { data } = await api.post(`/users/${userId}/report`, payload);
  return data.data;
}

export async function blockUser(userId) {
  if (isDevAuthBypass) {
    const blocked = JSON.parse(localStorage.getItem('conclave:blocked-users') || '[]');
    if (!blocked.includes(userId)) blocked.push(userId);
    localStorage.setItem('conclave:blocked-users', JSON.stringify(blocked));
    return { blocked: true };
  }
  const { data } = await api.post(`/users/${userId}/block`);
  return data.data;
}

export async function getBlockStatus(userId) {
  if (isDevAuthBypass) return { blocked: Boolean(JSON.parse(localStorage.getItem('conclave:blocked-users') || '[]').includes(userId)) };
  const { data } = await api.get(`/users/${userId}/block`);
  return data.data;
}

export async function unblockUser(userId) {
  if (isDevAuthBypass) {
    const blocked = JSON.parse(localStorage.getItem('conclave:blocked-users') || '[]').filter((id) => id !== userId);
    localStorage.setItem('conclave:blocked-users', JSON.stringify(blocked));
    return { blocked: false };
  }
  const { data } = await api.delete(`/users/${userId}/block`);
  return data.data;
}
