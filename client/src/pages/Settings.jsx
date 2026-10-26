import AttentionSettings from "../components/settings/AttentionSettings";
import { usePush } from "../contexts/PushContext";
import PrivacySecuritySettings from "../components/settings/PrivacySecuritySettings";
import EncryptionSettings from "../components/settings/EncryptionSettings";
import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import useNetworkStatus from "@/hooks/useNetworkStatus";
import Spinner from "@/components/ui/Spinner";
import ThemeSwitch from "@/components/ui/ThemeSwitch";
import { useToast } from "@/contexts/ToastContext";
import { getPreferences, updatePreferences } from "@/services/users.service";
import Page from "@/components/layout/Page";
import { clearLocalFiles, localFileUsage } from "@/lib/fileCache";
import {
  getMediaPreferences,
  saveMediaPreferences,
} from "@/lib/mediaPreferences";

// The same three states the server constrains (migration 015). Mirrored here so
// the control can be rendered from the list rather than hardcoded three times,
// and so the two cannot drift silently — a value the server would reject is not
// offered.
const LEVELS = [
  {
    value: "all",
    label: "Everything",
    description: "Mentions, messages, files and invites.",
  },
  {
    value: "mentions",
    label: "Mentions only",
    description: "Only when somebody @mentions you.",
  },
  {
    value: "none",
    label: "Nothing",
    description: "Record everything, notify you about nothing.",
  },
];

// One row per notification type, matching notification.service's allowlist. The
// server validates `muted` keys by name and answers 400 for anything else, so
// this list and that one have to agree.
const TYPES = [
  { value: "mention", label: "Mentions" },
  { value: "new_message", label: "New messages" },
  { value: "file_uploaded", label: "Uploaded files" },
  { value: "room_invite", label: "Room invites" },
  { value: "member_joined", label: "New room members" },
  { value: "task", label: "Task assignments" },
];

/**
 * Settings — appearance and notifications.
 *
 * Phase 7 made the notification section real. Before this it was an EmptyState
 * promising "notification preferences are being built", which was true only in
 * the sense that nothing stored a choice; the table, the endpoints and this
 * screen arrived together.
 *
 * Activity level is the coarse control and the per-type list is the fine one, and
 * they interact: `none` silences everything regardless of the type list, which is
 * why the type rows go dim rather than disappearing — the saved state stays
 * visible and editable, so switching back to `all` restores what you had chosen
 * rather than resetting it.
 */
export default function Settings() {
  const { setRoomHeader } = useOutletContext();
  const { toast } = useToast();
  const push = usePush();

  const [preferences, setPreferences] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);
  const network = useNetworkStatus();
  const [mediaPreferences, setMediaPreferences] = useState(getMediaPreferences);
  const [storageBytes, setStorageBytes] = useState(0);

  useEffect(() => {
    setRoomHeader("Settings");
    return () => setRoomHeader(null);
  }, [setRoomHeader]);

  useEffect(() => {
    let active = true;
    const refresh = () =>
      getPreferences()
        .then((value) => active && setPreferences(value))
        .catch(() => active && setPreferences(null))
        .finally(() => active && setIsLoading(false));
    refresh();
    window.addEventListener("conclave:preferences-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("conclave:preferences-changed", refresh);
    };
  }, []);

  useEffect(() => {
    localFileUsage().then(setStorageBytes);
  }, []);

  async function clearDownloads() {
    await clearLocalFiles();
    setStorageBytes(0);
    toast({ title: "Downloaded media cleared", tone: "success" });
  }

  async function save(updates, key) {
    setSavingKey(key);
    // Optimistic, then reconciled with the server's answer. The response is the
    // truth: PATCH merges with what is stored rather than replacing it, so the
    // value echoed back is the whole object and not just the field sent.
    const previous = preferences;
    setPreferences((prev) => ({ ...prev, ...updates }));
    try {
      const saved = await updatePreferences(updates);
      setPreferences(saved);
    } catch (err) {
      setPreferences(previous);
      toast({
        title: "Could not save",
        description:
          err.response?.data?.message || "Your preference was not saved.",
        tone: "error",
      });
    } finally {
      setSavingKey(null);
    }
  }

  if (isLoading) return <Spinner fullPage label="Loading settings" />;

  const level = preferences?.activity_level ?? "all";
  const muted = preferences?.muted ?? {};
  const silenced = level === "none";

  return (
    <Page width="form">
      <h1 className="text-h1 text-ink">Settings</h1>
      <p className="mt-2 text-body leading-relaxed text-muted">
        How Conclave looks, and when it interrupts you.
      </p>

      <PrivacySecuritySettings />
      <AttentionSettings />
      <details
        id="security-recovery"
        className="mt-6 rounded-xl border border-line p-4"
        open={window.location.hash === "#security-recovery"}
      >
        <summary className="cursor-pointer text-label text-ink">
          Security and recovery
        </summary>
        <EncryptionSettings />
      </details>

      <section className="mt-8 rounded-xl border border-line bg-surface p-6">
        <h2 className="text-h2 text-ink">Appearance</h2>
        <p className="mt-2 max-w-xl text-body leading-relaxed text-muted">
          Conclave follows your system appearance by default. Choosing Light or
          Dark overrides it for this device only; choosing System hands control
          back and keeps tracking as your system changes.
        </p>
        <div className="mt-5">
          <ThemeSwitch />
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-line bg-surface p-6">
        <h2 className="text-h2 text-ink">Notifications</h2>
        <p className="mt-2 max-w-xl text-body leading-relaxed text-muted">
          Conclave records everything you are shown either way. These settings
          decide what interrupts you, not what the workspace keeps.
        </p>

        <div className="mt-5 space-y-3 rounded-lg border border-line p-4">
          <h3 className="text-label font-semibold text-ink">
            Background notifications
          </h3>
          <label className="flex items-center justify-between gap-3 text-body text-ink">
            Allow background alerts on your devices
            <input
              type="checkbox"
              checked={preferences?.push_enabled !== false}
              disabled={savingKey === "push"}
              onChange={(event) =>
                save({ push_enabled: event.target.checked }, "push")
              }
              className="h-4 w-4 rounded border-line text-brand"
            />
          </label>
          <p role="status" className="text-metadata text-muted">
            {
              {
                loading: "Checking this browser…",
                enabled: "This browser is subscribed.",
                disabled: "Background notifications are off in this browser.",
                denied:
                  "Notifications are blocked in browser settings. Allow them there, then retry.",
                unsupported:
                  "Background notifications are not supported in this browser or context.",
                unconfigured:
                  "Background notifications are not configured on the server.",
                error: "Background notifications need attention.",
              }[push?.status || "unsupported"]
            }
          </p>
          {push?.error && (
            <p role="alert" className="text-metadata text-error">
              {push.error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {["disabled", "error"].includes(push?.status) && (
              <button
                type="button"
                onClick={push.enable}
                className="rounded-lg bg-brand px-3 py-2 text-label text-surface"
              >
                Enable in this browser
              </button>
            )}
            {push?.status === "enabled" && (
              <button
                type="button"
                onClick={push.disable}
                className="rounded-lg border border-line px-3 py-2 text-label text-ink"
              >
                Disable in this browser
              </button>
            )}
            {["denied", "error"].includes(push?.status) && (
              <button
                type="button"
                onClick={push.retry}
                className="rounded-lg border border-line px-3 py-2 text-label text-ink"
              >
                Retry notification setup
              </button>
            )}
          </div>
          <p className="text-metadata text-muted">
            Background alerts use a generic preview. Your saved preferences,
            conversation mutes, blocks and active conversations control
            delivery. Browser and operating system settings also apply.
          </p>
        </div>

        <fieldset className="mt-5">
          <legend className="text-label font-semibold text-ink">
            Notify me about
          </legend>
          <div className="mt-3 space-y-2">
            {LEVELS.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                  level === option.value
                    ? "border-brand bg-brand-soft"
                    : "border-line hover:bg-canvas"
                }`}
              >
                <input
                  type="radio"
                  name="activity_level"
                  value={option.value}
                  checked={level === option.value}
                  disabled={savingKey === `level-${option.value}`}
                  onChange={() =>
                    save(
                      { activity_level: option.value },
                      `level-${option.value}`,
                    )
                  }
                  className="mt-0.5 h-4 w-4 shrink-0 text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                />
                <span className="min-w-0">
                  <span className="block text-body font-medium text-ink">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-metadata text-muted">
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-7">
          <legend className="text-label font-semibold text-ink">
            Per-type overrides
          </legend>
          <p className="mt-1 text-metadata text-muted">
            {silenced
              ? "These are saved but not delivered while “Nothing” is selected."
              : "Switch off any kind you would rather not be interrupted by."}
          </p>
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line">
            {TYPES.map((type) => {
              const isMuted = Boolean(muted[type.value]);
              return (
                <li
                  key={type.value}
                  className="flex items-center gap-3 bg-surface px-3 py-2.5"
                >
                  <label
                    className={`flex flex-1 items-center gap-3 text-body ${
                      silenced ? "text-muted" : "cursor-pointer text-ink"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={!isMuted}
                      disabled={silenced || savingKey === `muted-${type.value}`}
                      onChange={() =>
                        save(
                          { muted: { ...muted, [type.value]: !isMuted } },
                          `muted-${type.value}`,
                        )
                      }
                      className="h-4 w-4 shrink-0 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                    />
                    {type.label}
                  </label>
                  {isMuted && !silenced && (
                    <span className="shrink-0 text-metadata text-muted">
                      Off
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </fieldset>
      </section>

      <section className="mt-6 rounded-xl border border-line bg-surface p-6">
        <h2 className="text-h2 text-ink">Storage and downloads</h2>
        <p className="mt-2 text-body text-muted">
          Choose which originals download automatically. Photos load a small
          preview; open a photo to download its original. Opened or manually
          downloaded files are cached when device storage allows.
        </p>
        <div className="mt-4 divide-y divide-line rounded-lg border border-line">
          {[
            ["video", "Automatically download videos"],
            ["documents", "Automatically download documents and audio"],
          ].map(([key, label]) => (
            <label
              key={key}
              className="flex cursor-pointer items-center justify-between gap-4 px-3 py-3 text-body text-ink"
            >
              {label}
              <input
                type="checkbox"
                checked={Boolean(mediaPreferences[key])}
                onChange={(event) => {
                  const next = {
                    ...mediaPreferences,
                    [key]: event.target.checked,
                  };
                  setMediaPreferences(next);
                  saveMediaPreferences(next);
                }}
                className="h-4 w-4 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
              />
            </label>
          ))}
        </div>
        <div className="mt-4 space-y-3">
          <label className="block text-label text-ink">
            Network for automatic downloads
            <select
              value={mediaPreferences.network || "any"}
              onChange={(event) => {
                const next = {
                  ...mediaPreferences,
                  network: event.target.value,
                };
                setMediaPreferences(next);
                saveMediaPreferences(next);
              }}
              className="mt-2 block min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-body"
            >
              <option value="any">Any connection</option>
              <option value="unmetered">Wi-Fi or Ethernet only</option>
              <option value="fast">Fast connections only</option>
            </select>
          </label>
          <p className="text-metadata text-muted">
            {network.type === "unknown"
              ? "This browser does not report Wi-Fi or cellular. Wi-Fi-only downloads stay paused when the connection is unknown."
              : `Reported connection: ${network.type}.`}{" "}
            Fast means the browser reports a 4G-level speed estimate; it does
            not mean Wi-Fi. Manual downloads remain available.
          </p>
          <label className="flex items-center justify-between gap-3 text-body text-ink">
            Pause automatic downloads when Data Saver is enabled
            <input
              type="checkbox"
              checked={mediaPreferences.respectSaveData !== false}
              onChange={(event) => {
                const next = {
                  ...mediaPreferences,
                  respectSaveData: event.target.checked,
                };
                setMediaPreferences(next);
                saveMediaPreferences(next);
              }}
              className="h-4 w-4 rounded border-line text-brand"
            />
          </label>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-body text-muted">
            Downloaded media: {(storageBytes / (1024 * 1024)).toFixed(1)} MB
          </p>
          <button
            type="button"
            onClick={clearDownloads}
            className="rounded-lg border border-line px-3 py-2 text-label font-medium text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          >
            Clear downloaded media
          </button>
        </div>
      </section>
    </Page>
  );
}
