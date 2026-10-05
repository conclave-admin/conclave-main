import axios from 'axios';
import { getAccessToken, getRefreshToken, saveSession, clearSession } from './session.js';

// Central axios instance — every page/component should call through this,
// not axios directly, so the auth header attaches consistently.
export const api = axios.create({
  baseURL: import.meta.env?.VITE_API_URL || '/api',
});

// This client has no interceptors, so a rejected refresh cannot retry itself.
const authApi = axios.create({ baseURL: api.defaults.baseURL });
let refreshPromise = null;

export function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    clearSession();
    return Promise.reject(new Error('Please sign in again.'));
  }
  refreshPromise = authApi.post('/auth/refresh', { refreshToken })
    .then(({ data }) => {
      // Do not resurrect a session after logout or replace a newer login.
      if (getRefreshToken() !== refreshToken) throw new Error('Session changed.');
      saveSession(data.data);
      return data.data.accessToken;
    })
    .catch((error) => {
      if ([400, 401].includes(error.response?.status) && getRefreshToken() === refreshToken) {
        clearSession();
      }
      throw error;
    })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function getValidAccessToken() {
  const token = getAccessToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp * 1000 > Date.now() + 30000) return token;
  } catch { /* Let the refresh endpoint recover an invalid cached token. */ }
  return refreshAccessToken();
}

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use((response) => response, async (error) => {
  const config = error.config;
  if (error.response?.status !== 401 || !config || config._retried || config.url?.startsWith('/auth/')) {
    throw error;
  }
  config._retried = true;
  // A late 401 may belong to a request sent before another request refreshed.
  let token = getAccessToken();
  if (!token || config.headers.Authorization === `Bearer ${token}`) {
    token = await refreshAccessToken();
  }
  config.headers.Authorization = `Bearer ${token}`;
  return api(config);
});
