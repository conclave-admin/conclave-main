import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import { useSyncReconciler } from "./SyncContext";
import { api } from "../lib/api";
import {
  pushSupport,
  configureBrowserPush,
  clearBrowserPush,
} from "../lib/pushNotifications";
const Context = createContext(null);
export function PushProvider({ children }) {
  const { user, sessionId } = useAuth();
  const [status, setStatus] = useState("loading");
  const [config, setConfig] = useState(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refreshRef = useRef(null);
  useEffect(() => {
    const version = ++generation.current;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        if (!pushSupport()) {
          if (version === generation.current) setStatus("unsupported");
          return;
        }
        if (!user?.id) {
          await clearBrowserPush();
          if (version === generation.current) setStatus("disabled");
          return;
        }
        if (Notification.permission === "denied") {
          await clearBrowserPush({ server: true });
          if (version === generation.current) setStatus("denied");
          return;
        }
        const response = (await api.get("/push/config", { timeout: 5000 })).data
          .data;
        if (version !== generation.current) return;
        setConfig(response);
        if (!response.configured) {
          setStatus("unconfigured");
          return;
        }
        if (
          localStorage.getItem(`conclave.push-optout.${user.id}`) === "true"
        ) {
          setStatus("disabled");
          return;
        }
        if (Notification.permission !== "granted") {
          setStatus("disabled");
          return;
        }
        const enabled = await configureBrowserPush(
          user.id,
          sessionId,
          response,
        );
        if (version === generation.current) {
          setStatus(enabled ? "enabled" : "disabled");
          setError("");
        }
      } catch (err) {
        if (version === generation.current) {
          setError(
            err.response?.data?.message ||
              "Could not connect background notifications. Retry when connected.",
          );
          setStatus("error");
        }
      } finally {
        busy = false;
      }
    };
    refreshRef.current = refresh;
    refresh();
    const focus = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const message = (event) => {
      if (event.data?.type === "PUSH_SUBSCRIPTION_CHANGED") refresh();
    };
    window.addEventListener("online", refresh);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    navigator.serviceWorker?.addEventListener("message", message);
    return () => {
      generation.current++;
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      navigator.serviceWorker?.removeEventListener("message", message);
    };
  }, [user?.id, sessionId]);
  useSyncReconciler(
    async (batch) => {
      if (batch.reset || batch.changes.some((c) => c.kind === "preferences"))
        window.dispatchEvent(new Event("conclave:preferences-changed"));
    },
    [user?.id],
  );
  const enable = async () => {
    if (!config?.configured || !pushSupport()) return;
    // Called directly from the button gesture; never prompt during startup.
    try {
      localStorage.removeItem(`conclave.push-optout.${user.id}`);
    } catch {}
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setStatus(permission === "denied" ? "denied" : "disabled");
      return;
    }
    await refreshRef.current?.();
  };
  const disable = async () => {
    try {
      localStorage.setItem(`conclave.push-optout.${user.id}`, "true");
    } catch {}
    await clearBrowserPush({ server: true });
    setStatus("disabled");
  };
  return (
    <Context.Provider
      value={{
        status,
        error,
        enable,
        disable,
        retry: () => refreshRef.current?.(),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function usePush() {
  return useContext(Context);
}
