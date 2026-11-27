import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import { useSyncReconciler } from "./SyncContext";
import { api } from "../lib/api";
import { pushSupportHint } from "../lib/pushCapabilities";
import {
  pushSupport,
  configureBrowserPush,
  clearBrowserPush,
} from "../lib/pushNotifications";
const Context = createContext(null);
export function PushProvider({ children }) {
  const { user, sessionId } = useAuth();
  const [status, setStatus] = useState("loading");
  const optedOut = useRef(new Map());
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refreshRef = useRef(null);
  useEffect(() => {
    const version = ++generation.current;
    let busy = false;
    let rerun = false;
    const refresh = async () => {
      if (version !== generation.current) return;
      if (busy) {
        rerun = true;
        return;
      }
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
        setError("");
        if (!response.configured) {
          setStatus("unconfigured");
          return;
        }
        let disabled = optedOut.current.get(user.id);
        if (disabled === undefined) {
          try {
            disabled = localStorage.getItem(`conclave.push-optout.${user.id}`) === "true";
          } catch { /* Browser storage can be restricted. */ }
        }
        if (disabled) {
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
        if (rerun && version === generation.current) {
          rerun = false;
          return refresh();
        }
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
    const storage = (event) => {
      if (event.key === null || event.key === `conclave.push-optout.${user?.id}`) {
        optedOut.current.delete(user?.id);
        refresh();
      }
    };
    window.addEventListener("storage", storage);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    navigator.serviceWorker?.addEventListener("message", message);
    return () => {
      generation.current++;
      window.removeEventListener("storage", storage);
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
    if (!user?.id || !pushSupport()) return;
    const version = generation.current;
    setError("");
    setStatus("loading");
    // Permission must be requested from the tap, before any network request.
    try {
      const permission = await Notification.requestPermission();
      if (version !== generation.current) return;
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "disabled");
        return;
      }
      optedOut.current.set(user.id, false);
      try { localStorage.removeItem(`conclave.push-optout.${user.id}`); } catch {}
      await refreshRef.current?.();
    } catch {
      if (version !== generation.current) return;
      setError("Could not enable notifications. Check this browser's permissions and retry.");
      setStatus("error");
    }
  };
  const disable = async () => {
    optedOut.current.set(user.id, true);
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
        supportHint: pushSupportHint(),
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
