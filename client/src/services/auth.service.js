import { api } from "../lib/api";
const ACCESS_KEY = "accessToken";
const REFRESH_KEY = "refreshToken";
function saveSession(session) {
  localStorage.setItem(ACCESS_KEY, session.accessToken);
  localStorage.setItem(REFRESH_KEY, session.refreshToken);
}
export const getAccessToken = () => localStorage.getItem(ACCESS_KEY);
export function clearSession() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}
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
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  try {
    if (refreshToken) await api.post("/auth/logout", { refreshToken });
  } catch {
    /* Local logout must still complete if the API is unavailable. */
  } finally {
    clearSession();
  }
}
