import { useAuth } from "../../contexts/AuthContext";
import { useSyncReconciler } from "../../contexts/SyncContext";
import { getSessionUserId } from "../../lib/session";
import { useEffect, useState } from "react";
import { isDevAuthBypass } from "../../config/devPreview";
import {
  encryptionStatus,
  refreshEncryption,
  createEncryptionBackup,
  restoreEncryptionBackup,
  approveEncryptionDevice,
  resetEncryptionIdentity,
} from "../../lib/encryption";
import Input from "../ui/Input";
import Button from "../ui/Button";

export default function EncryptionSettings() {
  const { user } = useAuth();
  const [storedState, setState] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [key, setKey] = useState(""),
    [createdKey, setCreatedKey] = useState(""),
    [busy, setBusy] = useState(false),
    [codes, setCodes] = useState({});
  const [resetPassword, setResetPassword] = useState(""),
    [confirmReset, setConfirmReset] = useState(false);
  const state = storedState?.userId === user?.id ? storedState : null;
  async function refresh() {
    if (isDevAuthBypass) {
      setNotice(
        "Device encryption requires a real signed-in account. Preview conversations remain server-readable.",
      );
      return;
    }
    try {
      setState(await encryptionStatus());
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    }
  }
  useEffect(() => {
    setState(null);
    setCreatedKey("");
    setKey("");
    setError("");
    setNotice("");
    refresh();
  }, [user?.id]);
  useSyncReconciler(
    async (batch) => {
      if (!isDevAuthBypass && batch.changes.some((c) => c.kind === "device"))
        await refresh();
    },
    [user?.id],
  );
  async function run(action) {
    setBusy(true);
    setError("");
    try {
      if (!isDevAuthBypass && getSessionUserId() !== user?.id)
        throw new Error("Your account changed. Reopen Settings.");
      await action();
      await refresh();
    } catch (e) {
      setError(
        e.response?.data?.message ||
          e.message ||
          "Could not update encryption.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="mt-6 space-y-4 rounded-xl border border-line bg-surface p-6"
      aria-labelledby="encryption-settings"
    >
      <h2 id="encryption-settings" className="text-h2 text-ink">
        Encryption and recovery
      </h2>
      <p className="text-body text-muted">
        New direct messages and private rooms encrypt message bodies, captions,
        file names, previews and originals on devices. Public and existing
        legacy conversations remain server-readable. Encryption does not hide
        membership, timing, reactions or delivery metadata.
      </p>
      {state && (
        <>
          <p className="text-body text-ink">
            {state.ready
              ? "This device is ready for encrypted conversations."
              : "Approve this device from an existing device, or restore your encrypted backup."}
          </p>
          <p className="text-label text-ink">Your account safety code</p>
          <code className="block break-all rounded-lg bg-canvas p-3 text-metadata text-ink">
            {state.fingerprint}
          </code>
          <p className="text-label text-ink">This device’s linking code</p>
          <code className="block break-all rounded-lg bg-canvas p-3 text-metadata text-ink">
            {state.deviceFingerprint}
          </code>
          {!state.ready && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await refreshEncryption();
                  window.dispatchEvent(new Event("conclave:keys-ready"));
                })
              }
            >
              Check device approval
            </Button>
          )}
          {state.ready &&
            state.devices
              .filter(
                (d) =>
                  !d.approved_at &&
                  !d.revoked_at &&
                  new Date(d.expires_at) > new Date(),
              )
              .map((device) => (
                <form
                  className="space-y-3 rounded-lg border border-line p-4"
                  key={device.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () => {
                      await approveEncryptionDevice(
                        device,
                        codes[device.id] || "",
                      );
                      setNotice(
                        "Device approved. Check approval on the new device.",
                      );
                    });
                  }}
                >
                  <p className="text-body text-ink">Link {device.label}</p>
                  <p className="text-metadata text-muted">
                    Compare the full linking code shown on the new device.
                    Approval transfers encryption keys and access to previous
                    encrypted history.
                  </p>
                  <Input
                    label="Code shown on the new device"
                    value={codes[device.id] || ""}
                    onChange={(e) =>
                      setCodes({ ...codes, [device.id]: e.target.value })
                    }
                  />
                  <Button type="submit" disabled={busy}>
                    Approve device
                  </Button>
                </form>
              ))}
        </>
      )}
      <div className="space-y-3 border-t border-line pt-4">
        <h3 className="text-label font-semibold text-ink">
          Encrypted key backup
        </h3>
        <p className="text-body text-muted">
          Store a recovery key somewhere safe outside Conclave. Your sign-in
          password cannot open this backup. Replacing a backup creates a new
          recovery key; the previous key will no longer restore it. Create a
          fresh backup after linking devices to include their keys.
        </p>
        <Button
          variant="secondary"
          disabled={busy || !state?.ready}
          onClick={() =>
            run(async () =>
              setCreatedKey({
                userId: user.id,
                key: await createEncryptionBackup(),
              }),
            )
          }
        >
          Create or replace encrypted backup
        </Button>
        {createdKey && state && createdKey.userId === user?.id && (
          <div className="space-y-2 rounded-lg border border-brand p-3">
            <p className="text-body text-ink">
              Save this recovery key now. It is not sent to the server.
            </p>
            <code className="block break-all text-body text-ink">
              {createdKey.key}
            </code>
            <Button variant="secondary" onClick={() => setCreatedKey("")}>
              I saved my recovery key
            </Button>
          </div>
        )}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await restoreEncryptionBackup(key);
              setKey("");
              setNotice("Encryption keys restored to this device.");
            });
          }}
        >
          <Input
            label="Encryption recovery key"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            required
          />
          <Button type="submit" variant="secondary" disabled={busy}>
            Restore encrypted backup
          </Button>
        </form>
      </div>
      <p className="text-metadata text-muted">
        Keep an approved device or recovery key. Losing both makes old encrypted
        history unrecoverable. This first version uses signed device
        certificates and independent message keys; it does not provide
        Signal-style forward secrecy or a post-compromise ratchet.
      </p>
      <details className="rounded-lg border border-line p-3">
        <summary className="cursor-pointer text-label text-error">
          Lost every device and recovery key?
        </summary>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (confirmReset)
              run(async () => {
                await resetEncryptionIdentity(resetPassword);
                setResetPassword("");
                setConfirmReset(false);
                setNotice(
                  "Encryption identity reset. Verify the new safety code with your contacts and create a new backup.",
                );
              });
          }}
        >
          <p className="text-body text-muted">
            Resetting encryption removes the old key backup and signs out other
            devices. It cannot recover old encrypted history. Contacts must
            verify your new safety code.
          </p>
          <Input
            label="Current password for encryption reset"
            type="password"
            autoComplete="current-password"
            required
            value={resetPassword}
            onChange={(e) => setResetPassword(e.target.value)}
          />
          <label className="flex items-start gap-2 text-body text-ink">
            <input
              type="checkbox"
              required
              checked={confirmReset}
              onChange={(e) => setConfirmReset(e.target.checked)}
            />
            I understand that old encrypted history cannot be recovered with
            this new identity.
          </label>
          <Button
            type="submit"
            variant="secondary"
            disabled={busy || !confirmReset}
          >
            Reset encryption identity
          </Button>
        </form>
      </details>
      <Button variant="secondary" disabled={busy} onClick={() => run(refresh)}>
        Refresh encryption devices
      </Button>
      {error && (
        <p role="alert" className="text-body text-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-body text-ink">
          {notice}
        </p>
      )}
    </section>
  );
}
