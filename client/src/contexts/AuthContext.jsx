import {clearBrowserPush} from '../lib/pushNotifications';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { isDevAuthBypass, previewUser } from "../config/devPreview";
import * as authService from "../services/auth.service";
import { clearLocalData } from "../lib/fileCache";
import { getCachedSessionUser, getRefreshToken, getSessionId, getSessionUserId, saveSessionUser } from '../lib/session';
import { deleteAccount as deleteAccountRequest, updateProfile as updateProfileRequest } from "../services/users.service";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => isDevAuthBypass ? previewUser : getCachedSessionUser());
  const [isLoading, setIsLoading] = useState(!isDevAuthBypass);
  const sessionId = getSessionId();
  const profileGeneration=useRef(0);
  useEffect(() => {
    if (isDevAuthBypass) return;
    const endSession = () => { window.dispatchEvent(new Event('conclave:sync-stop')); clearBrowserPush().catch(()=>{}); clearLocalData(); setUser(null); };
    const onStorage = (event) => {
      if ((event.key === 'refreshToken' || event.key === null) && !getRefreshToken()) endSession();
      else if (['refreshToken', 'conclave.session-user'].includes(event.key)) setUser(getCachedSessionUser());
    };
    window.addEventListener('conclave:session-ended', endSession);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('conclave:session-ended', endSession);
      window.removeEventListener('storage', onStorage);
    };
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
  async function refreshUser() {
    const version=++profileGeneration.current;
    const current=await authService.getCurrentUser();
    if(version!==profileGeneration.current)return;
    if(getSessionUserId()!==current.id)return;
    saveSessionUser(current);setUser(current);
    return current;
  }
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
    window.dispatchEvent(new Event('conclave:sync-stop'));
    window.dispatchEvent(new Event('conclave:outbox-stop'));
    await clearBrowserPush({server:true});
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
    profileGeneration.current++;
    saveSessionUser(next);
    setUser((prev) => prev?.id === next.id ? { ...prev, ...next } : prev);
    return next;
  }
  // The server already killed every session and dropped every membership, so the
  // local session has to go too — leaving it in place would render a shell that
  // 401s on every request until the next reload.
  async function deleteAccount() {
    await clearBrowserPush({server:true});
    await deleteAccountRequest();
    window.dispatchEvent(new Event('conclave:sync-stop'));
    window.dispatchEvent(new Event('conclave:outbox-stop'));
    await clearLocalData();
    setUser(null);
  }
  const value = useMemo(
    () => ({
      user,
      sessionId,
      isAuthenticated: isDevAuthBypass || Boolean(user),
      isLoading,
      login,
      register,
      logout,
      updateProfile,
      refreshUser,
      deleteAccount,
    }),
    [user, sessionId, isLoading],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
