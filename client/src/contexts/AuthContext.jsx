import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { isDevAuthBypass, previewUser } from "../config/devPreview";
import * as authService from "../services/auth.service";
const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const [user, setUser] = useState(isDevAuthBypass ? previewUser : null);
  const [isLoading, setIsLoading] = useState(!isDevAuthBypass);
  useEffect(() => {
    if (isDevAuthBypass) return;
    const endSession = () => setUser(null);
    window.addEventListener('conclave:session-ended', endSession);
    return () => window.removeEventListener('conclave:session-ended', endSession);
  }, []);
  useEffect(() => {
    if (isDevAuthBypass) return;
    let active = true;
    async function restore() {
      if (!authService.getAccessToken()) {
        setIsLoading(false);
        return;
      }
      try {
        const current = await authService.getCurrentUser();
        if (active) setUser(current);
      } catch {
        authService.clearSession();
      } finally {
        if (active) setIsLoading(false);
      }
    }
    restore();
    return () => {
      active = false;
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
    await authService.logout();
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
