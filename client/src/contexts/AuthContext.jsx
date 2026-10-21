import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { isDevAuthBypass, previewUser } from "../config/devPreview";
import * as authService from "../services/auth.service";
import { clearLocalData } from "../lib/fileCache";
import { getCachedSessionUser, getSessionUserId, saveSessionUser } from '../lib/session';
import { deleteAccount as deleteAccountRequest, updateProfile as updateProfileRequest } from "../services/users.service";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => isDevAuthBypass ? previewUser : getCachedSessionUser());
  const [isLoading, setIsLoading] = useState(!isDevAuthBypass);
  useEffect(() => {
    if (isDevAuthBypass) return;
    const endSession = () => { clearLocalData(); setUser(null); };
    window.addEventListener('conclave:session-ended', endSession);
    return () => window.removeEventListener('conclave:session-ended', endSession);
  }, []);
  useEffect(() => {
    if (isDevAuthBypass) return;
    let active = true;
    async function restore() {
      const restoringUserId = getSessionUserId();
      if (!authService.getAccessToken()) {
        setIsLoading(false);
        return;
      }
      if (navigator.onLine === false) {
        if (active) { setUser(getCachedSessionUser()); setIsLoading(false); }
        return;
      }
      try {
        const current = await authService.getCurrentUser();
        if (active && getSessionUserId() === current.id) setUser(current);
      } catch (error) {
        // A temporary outage must not erase drafts or the retained session.
        // The API interceptor already ends definitively rejected refreshes.
        if ([401, 403].includes(error.response?.status) && getSessionUserId() === restoringUserId) authService.clearSession();
        else if (active) setUser(getCachedSessionUser());
      } finally {
        if (active) setIsLoading(false);
      }
    }
    restore();
    window.addEventListener('online', restore);
    return () => {
      active = false;
      window.removeEventListener('online', restore);
    };
  }, []);
  async function login(values) {
    if (isDevAuthBypass) {
      setUser(previewUser);
      return;
    }
    const session = await authService.login(values);
    setUser(session.user);
  }
  async function register(values) {
    if (isDevAuthBypass) {
      setUser(previewUser);
      return;
    }
    const session = await authService.register(values);
    setUser(session.user);
  }
    async function logout() {
    if (isDevAuthBypass) {
      setUser(previewUser);
      return;
    }
    window.dispatchEvent(new Event('conclave:outbox-stop'));
    await authService.logout();
    await clearLocalData();
    setUser(null);
  }
  // Editing the profile has to land here, not only on the Profile page. The rail
  // footer and the navbar both read `user`, so a rename saved from the form would
  // otherwise show the old name everywhere until a reload — and the screen that
  // just told you it saved would be the one place it had not.
  async function updateProfile(updates) {
    const next = await updateProfileRequest(updates);
    saveSessionUser(next);
    setUser((prev) => prev?.id === next.id ? { ...prev, ...next } : prev);
    return next;
  }
  // The server already killed every session and dropped every membership, so the
  // local session has to go too — leaving it in place would render a shell that
  // 401s on every request until the next reload.
  async function deleteAccount() {
    await deleteAccountRequest();
    window.dispatchEvent(new Event('conclave:outbox-stop'));
    await clearLocalData();
    setUser(null);
  }
  const value = useMemo(
    () => ({
      user,
      isAuthenticated: isDevAuthBypass || Boolean(user),
      isLoading,
      login,
      register,
      logout,
      updateProfile,
      deleteAccount,
    }),
    [user, isLoading],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
