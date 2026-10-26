import { useEffect, useRef, useState } from "react";
import { useSyncReconciler } from "../../contexts/SyncContext";
import { getSessionUserId } from "../../lib/session";
import { isDevAuthBypass } from "../../config/devPreview";
import { accountMediaUsage, clearAccountMediaCache } from "../../lib/fileCache";
import { clearConversationForMe } from "../../lib/clearedConversations";
import { updateRoomPreferences } from "../../services/rooms.service";
import {
  management,
  changeRoomSettings,
  createInvitation,
  revokeInvitation,
  reviewJoin,
  handoverAdmin,
} from "../../services/roomLifecycle.service";
import Button from "../ui/Button";
import Input from "../ui/Input";
import Modal from "../ui/Modal";
const size = (value) => `${(Number(value || 0) / 1048576).toFixed(2)} MB`;
export default function ConversationManagement({ room, user, onChanged }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [link, setLink] = useState("");
  const [hours, setHours] = useState("168"),
    [uses, setUses] = useState("100"),
    [successor, setSuccessor] = useState(""),
    [handover, setHandover] = useState(false),
    [cacheConfirm, setCacheConfirm] = useState(false),
    [usage, setUsage] = useState(null);
  const owner = useRef(user.id);
  owner.current = user.id;
  const revision = useRef(0);
  const mutation = useRef(false);
  useEffect(() => {
    owner.current = user.id;
    return () => {
      owner.current = null;
      revision.current++;
    };
  }, [user.id]);
  const admin = room.members?.some(
      (m) => m.id === user.id && m.role === "admin",
    ),
    group = room.type !== "dm",
    preview = isDevAuthBypass;
  async function refresh(force = false) {
    if (mutation.current && !force) return;
    const version = ++revision.current;
    try {
      const value = await management(room.id);
      if (version === revision.current && owner.current === user.id)
        setData(value);
    } catch (e) {
      if (version === revision.current)
        setError(e.response?.data?.message || e.message);
    }
  }
  useEffect(() => {
    refresh();
    return () => {
      revision.current++;
    };
  }, [room.id, room]);
  useEffect(() => {
    let active = true;
    const refreshUsage = () =>
      accountMediaUsage(user.id)
        .then((bytes) => {
          if (active) setUsage(bytes);
        })
        .catch(() => {});
    refreshUsage();
    window.addEventListener("conclave:media-cache-removed", refreshUsage);
    return () => {
      active = false;
      window.removeEventListener("conclave:media-cache-removed", refreshUsage);
    };
  }, [user.id, notice]);
  useSyncReconciler(
    async (batch) => {
      if (
        batch.reset ||
        batch.changes.some(
          (c) =>
            c.room_id === room.id &&
            ["preferences", "room", "membership", "message"].includes(c.kind),
        )
      )
        await refresh();
    },
    [user.id, room.id],
  );
  async function run(work, message, rollback) {
    if (mutation.current) return;
    mutation.current = true;
    setNotice("");
    setBusy(true);
    setError("");
    try {
      if (!preview && getSessionUserId() !== user.id)
        throw new Error("Account changed. Reopen this conversation.");
      await work();
      if (owner.current !== user.id) return;
      setNotice(message);
      await refresh(true);
      await onChanged?.();
    } catch (e) {
      if (owner.current === user.id) rollback?.();
      if (owner.current === user.id)
        setError(
          e.response?.data?.message ||
            e.message ||
            "Could not update conversation.",
        );
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="mt-6 space-y-6">
      <section
        className="space-y-3 rounded-2xl border border-line bg-surface p-5"
        aria-labelledby="conversation-notifications"
      >
        <h2 id="conversation-notifications" className="text-h2 text-ink">
          Notifications and organization
        </h2>
        {data &&
          [
            ["muted", "Mute conversation"],
            ["pinned", "Pin conversation"],
            ["archived", "Archive conversation"],
          ].map(([key, label]) => (
            <label
              className="flex min-h-11 items-center justify-between gap-3 text-body text-ink"
              key={key}
            >
              {label}
              <input
                type="checkbox"
                checked={Boolean(data.preferences[key])}
                disabled={busy || preview}
                onChange={(e) => {
                  const value = e.target.checked,
                    previous = data;
                  setData({
                    ...data,
                    preferences: { ...data.preferences, [key]: value },
                  });
                  run(
                    () => updateRoomPreferences(room.id, { [key]: value }),
                    "Conversation preferences saved.",
                    () => setData(previous),
                  );
                }}
              />
            </label>
          ))}
      </section>
      <section
        className="space-y-3 rounded-2xl border border-line bg-surface p-5"
        aria-labelledby="conversation-storage"
      >
        <h2 id="conversation-storage" className="text-h2 text-ink">
          Storage
        </h2>
        <p className="text-body text-ink">
          Shared media:{" "}
          {data?.storage?.attachment_count ?? "…"} ·{" "}
          {size(data?.storage?.bytes)}
        </p>
        <p className="text-body text-ink">
          Downloaded on this device:{" "}
          {usage === null ? "Unavailable" : size(usage)}
        </p>
        <Button
          variant="secondary"
          disabled={busy || usage === null}
          onClick={() => setCacheConfirm(true)}
        >
          Remove downloaded copies
        </Button>
      </section>
      {group && (
        <section
          className="space-y-3 rounded-2xl border border-line bg-surface p-5"
          aria-labelledby="room-access"
        >
          <h2 id="room-access" className="text-h2 text-ink">
            Room access and permissions
          </h2>
          {data &&
            [
              ["join_approval", "Require approval to join"],
              ["member_can_send", "Allow participants to send messages"],
              [
                "member_can_invite",
                "Allow participants to create invitation links",
              ],
            ].map(([key, label]) => (
              <label
                className="flex min-h-11 items-center justify-between gap-3 text-body text-ink"
                key={key}
              >
                {label}
                <input
                  type="checkbox"
                  checked={Boolean(data[key])}
                  disabled={busy || !admin || preview}
                  onChange={(e) => {
                    const value = e.target.checked,
                      previous = data;
                    setData({ ...data, [key]: value });
                    run(
                      () => changeRoomSettings(room.id, { [key]: value }),
                      "Room permissions updated.",
                      () => setData(previous),
                    );
                  }}
                />
              </label>
            ))}
          {(admin || data?.member_can_invite) && (
            <form
              className="space-y-3 border-t border-line pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const invitation = await createInvitation(room.id, {
                    expiresInHours: Number(hours),
                    maxUses: Number(uses),
                  });
                  setLink(`${location.origin}/join#token=${invitation.token}`);
                }, "Invitation created. Save this link now; it is not shown again.");
              }}
            >
              <h3 className="text-label text-ink">Create an invitation</h3>
              <Input
                label="Invitation expiry in hours"
                type="number"
                min="1"
                max="720"
                required
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
              <Input
                label="Maximum joins"
                type="number"
                min="1"
                max="10000"
                required
                value={uses}
                onChange={(e) => setUses(e.target.value)}
              />
              <Button type="submit" disabled={busy || preview}>
                Create invitation link
              </Button>
            </form>
          )}
          {link && (
            <Input
              label="Invitation link — copy and share privately"
              value={link}
              readOnly
            />
          )}
          {admin &&
            data?.invites.map((invite) => (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3"
                key={invite.id}
              >
                <p className="text-metadata text-muted">
                  {invite.revoked_at
                    ? "Revoked"
                    : new Date(invite.expires_at) <= new Date()
                      ? "Expired"
                      : invite.uses >= invite.max_uses
                        ? "Exhausted"
                        : "Active"}{" "}
                  · {invite.uses}/{invite.max_uses} joins · expires{" "}
                  {new Date(invite.expires_at).toLocaleString()}
                </p>
                {!invite.revoked_at && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => revokeInvitation(room.id, invite.id),
                        "Invitation revoked.",
                      )
                    }
                  >
                    Revoke invitation
                  </Button>
                )}
              </div>
            ))}
          {admin && (
            <>
              <h3 className="pt-3 text-label text-ink">Join requests</h3>
              {!data?.requests.length && (
                <p className="text-body text-muted">
                  No pending join requests.
                </p>
              )}
              {data?.requests.map((request) => (
                <div
                  className="space-y-2 rounded-lg border border-line p-3"
                  key={request.user_id}
                >
                  <p className="break-words text-body text-ink">
                    {request.display_name}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            reviewJoin(room.id, request.user_id, "approved"),
                          "Join request approved.",
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            reviewJoin(room.id, request.user_id, "rejected"),
                          "Join request declined.",
                        )
                      }
                    >
                      Decline
                    </Button>
                  </div>
                </div>
              ))}
              <form
                className="space-y-3 border-t border-line pt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  setHandover(true);
                }}
              >
                <h3 className="text-label text-ink">
                  Hand over your admin role
                </h3>
                <label className="block text-body text-ink">
                  Successor
                  <select
                    aria-label="Admin successor"
                    required
                    className="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface p-2"
                    value={successor}
                    onChange={(e) => setSuccessor(e.target.value)}
                  >
                    <option value="">Choose a participant</option>
                    {room.members
                      ?.filter((m) => m.id !== user.id)
                      .map((m) => (
                        <option value={m.id} key={m.id}>
                          {m.display_name}
                        </option>
                      ))}
                  </select>
                </label>
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={busy || !successor || preview}
                >
                  Review admin handover
                </Button>
              </form>
            </>
          )}
        </section>
      )}
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
      <Modal
        open={handover}
        title="Confirm admin handover"
        onClose={() => !busy && setHandover(false)}
      >
        <p className="text-body text-ink">
          {room.members?.find((m) => m.id === successor)?.display_name} will be
          an admin and you will become a participant. You can leave afterward.
          Other admins keep their roles.
        </p>
        <Button
          disabled={busy}
          onClick={() =>
            run(async () => {
              await handoverAdmin(room.id, successor);
              setHandover(false);
            }, "Admin role handed over.")
          }
        >
          Confirm handover
        </Button>
      </Modal>
      <Modal
        open={cacheConfirm}
        title="Remove downloaded copies?"
        onClose={() => !busy && setCacheConfirm(false)}
      >
        <p className="text-body text-ink">
          Remove this account’s downloaded media from this device? Messages and
          originals remain; pending sends are kept.
        </p>
        <Button
          disabled={busy}
          onClick={() =>
            run(async () => {
              await clearAccountMediaCache(user.id);
              setCacheConfirm(false);
            }, "Local downloaded copies removed.")
          }
        >
          Confirm cache removal
        </Button>
      </Modal>
    </div>
  );
}
export function PersonalHistoryActions({ roomId, userId, onChanged }) {
  const [scope, setScope] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <Button variant="secondary" onClick={() => setScope("account")}>
        Clear for me on all devices
      </Button>
      <Button variant="ghost" onClick={() => setScope("device")}>
        Clear on this device only
      </Button>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      <Modal
        open={Boolean(scope)}
        title="Clear your conversation history?"
        onClose={() => !busy && setScope(null)}
      >
        <p className="text-body text-ink">
          {scope === "account"
            ? "Hide messages already in this conversation on all your signed-in devices."
            : "Hide messages on this browser only."}{" "}
          Other participants keep their messages. Pending sends and future
          messages remain. Separate decisions/tasks and downloaded copies are
          not deleted.
        </p>
        <Button
          disabled={busy || (isDevAuthBypass && scope === "account")}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await clearConversationForMe(userId, roomId, scope);
              setScope(null);
              await onChanged?.();
            } catch (e) {
              setError(e.response?.data?.message || e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Confirm clear for me
        </Button>
      </Modal>
    </>
  );
}
