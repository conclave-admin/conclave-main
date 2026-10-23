import { useCallback, useEffect, useState, useRef } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useSyncReconciler } from "../../contexts/SyncContext";
import {
  getPrivacy,
  savePrivacy,
  getSessions,
  revokeSession,
  renameSession,
  requestVerification,
} from "../../services/security.service";
import Button from "../ui/Button";
import Input from "../ui/Input";

export default function PrivacySecuritySettings() {
  const { user, logout } = useAuth();
  const owner = useRef(user?.id);
  owner.current = user?.id;
  const [dataOwner, setDataOwner] = useState(null);
  const [privacy, setPrivacy] = useState(null),
    [sessions, setSessions] = useState([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [target, setTarget] = useState(null),
    [password, setPassword] = useState(""),
    [label, setLabel] = useState("");
  const refresh = useCallback(async () => {
    const id = user?.id;
    const [p, s] = await Promise.all([getPrivacy(), getSessions()]);
    if (owner.current !== id) return;
    setPrivacy(p);
    setSessions(s);
    setDataOwner(id);
  }, [user?.id]);
  useEffect(() => {
    setTarget(null);
    setPassword("");
    setPrivacy(null);
    setSessions([]);
    setDataOwner(null);
    refresh().catch(() =>
      setError("Could not load privacy and devices. Retry when connected."),
    );
  }, [refresh]);
  useSyncReconciler(
    async (batch) => {
      if (
        batch.reset ||
        batch.changes.some((c) =>
          ["preferences", "block", "session"].includes(c.kind),
        )
      )
        await refresh();
    },
    [user?.id],
  );
  async function save(values) {
    setBusy(true);
    setError("");
    try {
      setPrivacy(await savePrivacy(values));
      setNotice("Privacy settings saved.");
    } catch (e) {
      setError(e.response?.data?.message || "Could not save privacy settings.");
    } finally {
      setBusy(false);
    }
  }
  async function revoke(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await revokeSession(target.id, password);
      setPassword("");
      setTarget(null);
      if (target.current) await logout();
      else await refresh();
      setNotice("Selected sessions signed out.");
    } catch (e) {
      setError(
        e.response?.data?.message || "Could not sign out this device. Retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section
        className="mt-6 rounded-xl border border-line bg-surface p-6"
        aria-labelledby="privacy-settings"
      >
        <h2 id="privacy-settings" className="text-h2 text-ink">
          Privacy
        </h2>
        <p className="mt-2 text-body text-muted">
          Connections are people sharing a room with you or an accepted direct
          conversation. Blocking hides your photo, about and activity in both
          directions. Names remain visible for message attribution.
        </p>
        {privacy && dataOwner === user?.id && (
          <div className="mt-4 space-y-4">
            {[
              ["online_visibility", "Who can see when you are online"],
              ["last_seen_visibility", "Who can see your last active time"],
              ["photo_visibility", "Who can see your profile photo"],
              ["about_visibility", "Who can see your about"],
            ].map(([key, title]) => (
              <label key={key} className="block text-body text-ink">
                {title}
                <select
                  className="mt-1 block min-h-11 w-full rounded-lg border border-line bg-surface px-3"
                  value={privacy[key]}
                  disabled={busy}
                  onChange={(e) => save({ [key]: e.target.value })}
                >
                  <option value="everyone">Everyone</option>
                  <option value="connections">Connections</option>
                  <option value="nobody">Nobody</option>
                </select>
              </label>
            ))}
            <label className="block text-body text-ink">
              New direct messages
              <select
                className="mt-1 block min-h-11 w-full rounded-lg border border-line bg-surface px-3"
                value={privacy.dm_policy}
                disabled={busy}
                onChange={(e) => save({ dm_policy: e.target.value })}
              >
                <option value="requests">
                  Message requests from unknown people
                </option>
                <option value="everyone">Allow everyone</option>
                <option value="connections">Connections only</option>
                <option value="nobody">No new direct conversations</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-3 text-body text-ink">
              Share read receipts in direct messages
              <input
                type="checkbox"
                checked={privacy.read_receipts}
                disabled={busy}
                onChange={(e) => save({ read_receipts: e.target.checked })}
              />
            </label>
            <p className="text-metadata text-muted">
              Direct-message read receipts are shared only when both people
              allow them. Group read receipts remain visible. Hiding online
              status also hides viewing, typing and recording indicators.
              Previously downloaded photos cannot be recalled from another
              device.
            </p>
          </div>
        )}
      </section>
      <section
        className="mt-6 rounded-xl border border-line bg-surface p-6"
        aria-labelledby="account-security"
      >
        <h2 id="account-security" className="text-h2 text-ink">
          Account and devices
        </h2>
        <p className="mt-2 text-body text-muted">
          {user?.email_verified_at
            ? "Your email address is verified."
            : "Verify your email so you can recover access to your account."}
        </p>
        {!user?.email_verified_at && (
          <Button
            className="mt-3"
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setNotice((await requestVerification()).message);
              } catch (e) {
                setError(
                  e.response?.data?.message ||
                    "Could not request verification.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            Send verification email
          </Button>
        )}
        <form
          className="mt-5 flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await renameSession(label);
              setLabel("");
              await refresh();
            } catch (e) {
              setError(
                e.response?.data?.message || "Could not rename this device.",
              );
            }
          }}
        >
          <Input
            label="Name this device"
            value={label}
            maxLength={80}
            required
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button type="submit" variant="secondary">
            Save device name
          </Button>
        </form>
        <ul className="mt-4 divide-y divide-line">
          {(dataOwner === user?.id ? sessions : []).map((session) => (
            <li className="py-4" key={session.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-body text-ink">
                  {session.device_label}
                  {session.current ? " · This device" : ""}
                </strong>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setTarget(session);
                    setPassword("");
                  }}
                >
                  Sign out
                </Button>
              </div>
              <p className="mt-1 break-words text-metadata text-muted">
                {session.user_agent || "Browser details unavailable"}
              </p>
              <p className="mt-1 text-metadata text-muted">
                Last active {new Date(session.last_active_at).toLocaleString()}{" "}
                · Signed in {new Date(session.created_at).toLocaleDateString()}
              </p>
            </li>
          ))}
        </ul>
        {sessions.some((s) => !s.current) && (
          <Button
            variant="secondary"
            onClick={() => {
              setTarget({ id: "others", device_label: "all other devices" });
              setPassword("");
            }}
          >
            Sign out other devices
          </Button>
        )}
        {target && dataOwner === user?.id && (
          <form
            onSubmit={revoke}
            className="mt-4 space-y-3 rounded-lg border border-line p-4"
          >
            <p className="text-body text-ink">
              Confirm sign-out for {target.device_label}.
            </p>
            <Input
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={password}
              required
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                Confirm sign out
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setTarget(null);
                  setPassword("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        <Button
          variant="secondary"
          className="mt-4"
          onClick={() =>
            refresh().catch(() => setError("Could not refresh devices."))
          }
        >
          Refresh devices
        </Button>
      </section>
      {error && (
        <p role="alert" className="mt-3 text-body text-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-body text-ink">
          {notice}
        </p>
      )}
    </>
  );
}
