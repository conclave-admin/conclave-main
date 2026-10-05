import { api } from "../lib/api";
import { saveSession, clearSession, getRefreshToken } from '../lib/session';
export { getAccessToken, clearSession } from '../lib/session';
export async function login(credentials) {
  const { data } = await api.post("/auth/login", credentials);
  saveSession(data.data);
  return data.data;
}
export async function register(details) {
  const { data } = await api.post("/auth/register", details);
  saveSession(data.data);
  return data.data;
}
export async function getCurrentUser() {
  const { data } = await api.get("/users/me");
  return data.data;
}
export async function logout() {
  const refreshToken = getRefreshToken();
  try {
    if (refreshToken) await api.post("/auth/logout", { refreshToken });
  } catch {
    /* Local logout must still complete if the API is unavailable. */
  } finally {
    clearSession();
  }
}
