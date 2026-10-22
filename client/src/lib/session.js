export const getAccessToken = () => localStorage.getItem('accessToken');
export const getRefreshToken = () => localStorage.getItem('refreshToken');

export function getSessionId() {
  try {
    const body = getAccessToken()?.split('.')[1];
    return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))).sid || null;
  } catch { return null; }
}

export function getSessionUserId() {
  try {
    const body = getAccessToken()?.split('.')[1];
    return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))).sub || null;
  } catch { return null; }
}

export function getCachedSessionUser() {
  try {
    const user = JSON.parse(localStorage.getItem('conclave.session-user') || 'null');
    return user?.id === getSessionUserId() ? user : null;
  } catch { return null; }
}

export function saveSessionUser(user) {
  try {
    if (!user?.id || getSessionUserId() !== user.id) return;
    localStorage.setItem('conclave.session-user', JSON.stringify(user));
  } catch { /* The server remains available when profile caching is blocked. */ }
}

export function saveSession(session) {
  localStorage.setItem('accessToken', session.accessToken);
  localStorage.setItem('refreshToken', session.refreshToken);
  if (session.user) saveSessionUser(session.user);
}

export function clearSession() {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('conclave.session-user');
  window.dispatchEvent(new Event('conclave:session-ended'));
}
