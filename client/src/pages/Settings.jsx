import AttentionSettings from "../components/settings/AttentionSettings";
import { usePush } from "../contexts/PushContext";
import PrivacySecuritySettings from "../components/settings/PrivacySecuritySettings";
import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import useNetworkStatus from "@/hooks/useNetworkStatus";
import Spinner from "@/components/ui/Spinner";
import ThemeSwitch from "@/components/ui/ThemeSwitch";
import { useToast } from "@/contexts/ToastContext";
import { getPreferences, updatePreferences } from "@/services/users.service";
import Page from "@/components/layout/Page";
import {
  clearAccountMediaCache,
  accountMediaUsage,
  listAccountDownloads,
  removeLocalFile,
} from "@/lib/fileCache";
import { attachmentAccount } from "@/services/attachments.service";
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
  { value: "decision", label: "Decision changes" },
  { value: "event_reminder", label: "Event reminders" },
  { value: "event_cancelled", label: "Event cancellations" },
];

const SETTINGS_SECTIONS = [
  ["appearance", "Appearance"],
  ["notifications", "Notifications"],
  ["media", "Media"],
  ["privacy", "Privacy & security"],
  ["attention", "Focus"],
];
const QUIET_DAYS = [
  [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"],
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
  const [downloadedFiles, setDownloadedFiles] = useState([]);
  const [activeSection, setActiveSection] = useState("appearance");

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
    if (isLoading) return undefined;
    const scroller = document.querySelector(".settings-page")?.closest(".app-page");
    if (!scroller) return undefined;
    const updateActiveSection = () => {
      const top = scroller.getBoundingClientRect().top + 96;
      let current = SETTINGS_SECTIONS[0][0];
      for (const [id] of SETTINGS_SECTIONS) {
        const section = document.getElementById(`settings-${id}`);
        if (section && section.getBoundingClientRect().top <= top) current = id;
      }
      setActiveSection(current);
    };
    updateActiveSection();
    scroller.addEventListener("scroll", updateActiveSection, { passive: true });
    return () => scroller.removeEventListener("scroll", updateActiveSection);
  }, [isLoading]);

  useEffect(() => {
    let active = true;
    const refresh = () =>
      Promise.all([
        accountMediaUsage(attachmentAccount()),
        listAccountDownloads(attachmentAccount()),
      ])
        .then(([bytes, files]) => {
          if (active) {
            setStorageBytes(bytes);
            setDownloadedFiles(files);
          }
        })
        .catch(() => {});
    refresh();
    window.addEventListener("conclave:media-cache-saved", refresh);
    window.addEventListener("conclave:media-cache-removed", refresh);
    return () => {
      active = false;
      window.removeEventListener("conclave:media-cache-saved", refresh);
      window.removeEventListener("conclave:media-cache-removed", refresh);
    };
  }, []);

  async function clearDownloads() {
    await clearAccountMediaCache(attachmentAccount());
    setDownloadedFiles([]);
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
      // Let the live alert policy (ChatsContext) pick up the new values
      // immediately instead of on the next full page load — otherwise a user
      // who mutes a type here keeps getting in-app toasts until they refresh.
      window.dispatchEvent(
        new CustomEvent("conclave:preferences-changed", { detail: saved }),
      );
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
  const quietWindow = preferences?.quiet_hours?.[0] || {
    days: [],
    start: "22:00",
    end: "08:00",
  };
  const quietTimezone = preferences?.quiet_hours_timezone || "UTC";
  const timezoneOptions = typeof Intl.supportedValuesOf === "function"
    ? [...new Set([quietTimezone, "UTC", ...Intl.supportedValuesOf("timeZone")])]
    : [...new Set([quietTimezone, "UTC", "Africa/Lagos", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"])];

  function saveQuietWindow(window, timezone = quietTimezone) {
    const days = [...new Set(window.days)].sort((a, b) => a - b);
    const windows = days.length ? [{ days, start: window.start, end: window.end }] : [];
    save({ quiet_hours: windows, quiet_hours_timezone: timezone }, "quietHours");
  }

  return (
    <Page width="form" className="settings-page">
      <h1 className="text-h1 text-ink">Settings</h1>
      <p className="mt-2 text-body leading-relaxed text-muted">
        How Conclave looks, and when it interrupts you.
      </p>

      <nav
        aria-label="Settings sections"
        className="settings-navigation mt-5 grid grid-cols-2 gap-2 md:flex md:overflow-x-auto md:pb-2"
      >
        {SETTINGS_SECTIONS.map(([id, label], index) => (
          <button
            key={id}
            type="button"
            aria-current={activeSection === id ? "location" : undefined}
            className={`min-h-11 rounded-xl border px-3 text-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand md:min-h-10 md:shrink-0 md:rounded-full ${index === SETTINGS_SECTIONS.length - 1 ? "col-span-2 md:col-span-1" : ""} ${activeSection === id ? "border-brand bg-brand-soft text-brand" : "border-line bg-surface text-ink hover:bg-canvas"}`}
            onClick={() => {
              setActiveSection(id);
              const target = document.getElementById(`settings-${id}`);
              target?.scrollIntoView({
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                  .matches
                  ? "instant"
                  : "smooth",
                block: "start",
              });
              target?.focus({ preventScroll: true });
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <section
        id="settings-appearance"
        tabIndex={-1}
        className="mt-5 rounded-xl border border-line bg-surface p-5 md:p-6"
      >
        <h2 className="text-h2 text-ink">Appearance</h2>
        <p className="mt-2 max-w-xl text-body leading-relaxed text-muted">
          Choose a theme for this device. System follows your device’s
          appearance.
        </p>
        <div className="mt-5">
          <ThemeSwitch />
        </div>
      </section>

      <section
        id="settings-notifications"
        tabIndex={-1}
        className="mt-6 rounded-xl border border-line bg-surface p-5 md:p-6"
      >
        <h2 className="text-h2 text-ink">Notifications</h2>
        <p className="mt-2 max-w-xl text-body leading-relaxed text-muted">
          Choose your alerts. Your activity history stays available.
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
                  push?.supportHint || "Background notifications are not supported in this browser or context.",
                unconfigured:
                  "Background notifications are not configured on the server.",
                error: "Background notifications need attention.",
              }[push?.status || "unsupported"]
            }
          </p>
          <p className="text-metadata text-muted">Enable notifications on each device you use. Your device’s notification settings and Focus mode also apply.</p>
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
            {["denied", "error", "unconfigured"].includes(push?.status) && (
              <button
                type="button"
                onClick={push.retry}
                className="rounded-lg border border-line px-3 py-2 text-label text-ink"
              >
                Retry notification setup
              </button>
            )}
          </div>
          <label className="flex items-center justify-between gap-3 text-body text-ink">
            Show sender and message preview in notifications
            <input
              type="checkbox"
              checked={preferences?.push_preview_enabled !== false}
              disabled={savingKey === "preview"}
              onChange={(event) =>
                save({ push_preview_enabled: event.target.checked }, "preview")
              }
              className="h-4 w-4 rounded border-line text-brand"
            />
          </label>
          <p className="text-metadata text-muted">
            {preferences?.push_preview_enabled !== false
              ? "Background alerts show who sent it and a short preview, like a text message. Turn this off to show only “You have new activity in Conclave” — useful on a shared screen or lock screen."
              : "Background alerts show only “You have new activity in Conclave”, with no sender or message text."}{" "}
            Your saved preferences, conversation mutes, blocks and active
            conversations still control delivery either way. Browser and
            operating system settings also apply.
          </p>
        </div>

        <div className="mt-4 space-y-3 rounded-lg border border-line p-4">
          <h3 className="text-label font-semibold text-ink">
            While the app is open
          </h3>
          <label className="flex items-center justify-between gap-3 text-body text-ink">
            In-app alerts for new messages
            <input
              type="checkbox"
              checked={preferences?.in_app_alerts_enabled !== false}
              disabled={savingKey === "inApp"}
              onChange={(event) =>
                save({ in_app_alerts_enabled: event.target.checked }, "inApp")
              }
              className="h-4 w-4 rounded border-line text-brand"
            />
          </label>
          <p className="text-metadata text-muted">
            {preferences?.in_app_alerts_enabled !== false
              ? "A short sound and a banner appear for messages in conversations you are not currently reading. Clicking the banner opens that conversation."
              : "No sound or banner while the app is open — unread counts on the chat list still update."}{" "}
            Never applies to the conversation on screen, and always respects
            do-not-disturb, muted conversations and your notify settings below.
          </p>
        </div>

        <div className="mt-4 space-y-4 rounded-lg border border-line p-4">
          <div>
            <h3 className="text-label font-semibold text-ink">Quiet hours</h3>
            <p className="mt-1 text-metadata text-muted">
              Pause push, sound and in-app message alerts on a weekly schedule. Messages and unread counts are still saved.
            </p>
          </div>
          <fieldset>
            <legend className="text-label text-ink">Repeat on</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {QUIET_DAYS.map(([day, label]) => {
                const selected = quietWindow.days.includes(day);
                return (
                  <label key={day} className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-full border px-3 text-label ${selected ? "border-brand bg-brand-soft text-brand" : "border-line text-ink"}`}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={savingKey === "quietHours"}
                      onChange={() => saveQuietWindow({
                        ...quietWindow,
                        days: selected ? quietWindow.days.filter((value) => value !== day) : [...quietWindow.days, day],
                      }, !preferences?.quiet_hours?.length && quietTimezone === "UTC" && typeof Intl !== "undefined"
                        ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
                        : quietTimezone)}
                      className="h-4 w-4 rounded border-line text-brand"
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
            <label className="space-y-1 text-label text-ink">
              Starts
              <input type="time" value={quietWindow.start} disabled={!quietWindow.days.length || savingKey === "quietHours"} onChange={(event) => saveQuietWindow({ ...quietWindow, start: event.target.value })} className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-body" />
            </label>
            <label className="space-y-1 text-label text-ink">
              Ends
              <input type="time" value={quietWindow.end} disabled={!quietWindow.days.length || savingKey === "quietHours"} onChange={(event) => saveQuietWindow({ ...quietWindow, end: event.target.value })} className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-body" />
            </label>
          </div>
          <label className="block max-w-sm space-y-1 text-label text-ink">
            Time zone
            <select value={quietTimezone} disabled={savingKey === "quietHours"} onChange={(event) => saveQuietWindow(quietWindow, event.target.value)} className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-body">
              {timezoneOptions.map((zone) => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <p className="text-metadata text-muted" role="status">
            {quietWindow.days.length ? `Quiet ${quietWindow.start}–${quietWindow.end} · ${quietTimezone}` : "Quiet hours are off."}
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

      <section
        id="settings-media"
        tabIndex={-1}
        className="mt-6 rounded-xl border border-line bg-surface p-6"
      >
        <h2 className="text-h2 text-ink">Storage and downloads</h2>
        <p className="mt-2 text-body text-muted">
          Files download quietly for offline use. Manage downloads on this
          device.
        </p>
        <div className="mt-4 divide-y divide-line rounded-lg border border-line">
          {[
            ["images", "Automatically download photos"],
            ["audio", "Automatically download audio"],
            ["video", "Automatically download videos"],
            ["documents", "Automatically download documents"],
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
                  networkExplicit: true,
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
        {downloadedFiles.length > 0 && (
          <details className="mt-4 rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-label text-ink">
              Downloaded files ({downloadedFiles.length})
            </summary>
            <ul className="mt-2 max-h-64 divide-y divide-line overflow-auto">
              {downloadedFiles.map((file) => (
                <li
                  key={file.key}
                  className="flex min-w-0 items-center gap-3 py-2"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-body"
                    title={file.filename}
                  >
                    {file.filename || "Attachment"}
                    <span className="ml-2 text-xs text-muted">
                      {(file.size / (1024 * 1024)).toFixed(1)} MB
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeLocalFile(file.key)}
                    aria-label={`Remove offline copy ${file.filename || "attachment"}`}
                    className="min-h-11 shrink-0 px-2 text-label text-error"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="mt-3 text-xs text-muted">
          Offline copies stay until you remove them or clear browser storage.
          Browser storage limits still apply.
        </p>
      </section>
      <div id="settings-privacy" tabIndex={-1} className="scroll-mt-4">
        <PrivacySecuritySettings />
      </div>
      <div id="settings-attention" tabIndex={-1} className="scroll-mt-4">
        <AttentionSettings />
      </div>
    </Page>
  );
}
