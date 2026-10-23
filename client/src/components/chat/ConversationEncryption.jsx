import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuth } from "../../contexts/AuthContext";
import { useEffect, useState } from "react";
import {
  encryptedConversationDevices,
  identityFingerprint,
  trustEncryptionIdentity,
} from "../../lib/encryption";
import Input from "../ui/Input";
import Button from "../ui/Button";
export default function ConversationEncryption({ room }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [members, setMembers] = useState([]),
    [error, setError] = useState(""),
    [codes, setCodes] = useState({}),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    if (room?.encryption_mode === "e2ee-v1")
      encryptedConversationDevices(room.id)
        .then(async (roster) => {
          const list = await Promise.all(
            roster.members.map(async (u) => ({
              ...u,
              fingerprint: u.identity_public_key
                ? await identityFingerprint(u.identity_public_key)
                : null,
            })),
          );
          if (active) setMembers(list);
        })
        .catch((e) => {
          if (active) setError(e.response?.data?.message || e.message);
        });
    return () => {
      active = false;
    };
  }, [room?.id, room?.encryption_mode]);
  if (room?.encryption_mode !== "e2ee-v1")
    return (
      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="text-h2 text-ink">Conversation privacy</h2>
        <p className="mt-2 text-body text-muted">
          This conversation is server-readable. For encrypted messages, start a
          new direct conversation or private room. Existing history is not
          silently converted.
        </p>
        {room.superseded_by ? (
          <Link
            className="mt-3 block text-body text-brand"
            to={`/chats/${room.superseded_by}`}
          >
            Open the encrypted conversation
          </Link>
        ) : (
          (room.type === "dm" ||
            (room.type !== "public" &&
              room.members?.some(
                (m) => m.id === user?.id && m.role === "admin",
              ))) && (
            <Button
              className="mt-3"
              variant="secondary"
              onClick={async () => {
                try {
                  const response = await api.post(
                    `/encryption/rooms/${room.id}/upgrade`,
                  );
                  navigate(`/chats/${response.data.data.roomId}`);
                } catch (e) {
                  setError(e.response?.data?.message || e.message);
                }
              }}
            >
              Continue in a new encrypted conversation
            </Button>
          )
        )}
        {error && (
          <p role="alert" className="mt-3 text-body text-error">
            {error}
          </p>
        )}
      </section>
    );
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-5">
      <h2 className="text-h2 text-ink">End-to-end encryption</h2>
      <p className="text-body text-muted">
        Compare account safety codes through another trusted channel. A changed
        identity pauses encrypted sends until you verify it. Server search and
        collaboration exports are unavailable here; search uses messages already
        available on this device.
      </p>
      {members.map((member) => (
        <form
          key={member.id}
          className="space-y-2 border-t border-line py-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await trustEncryptionIdentity(
                member.id,
                member.identity_public_key,
                codes[member.id] || "",
              );
              setNotice("Safety code verified on this device.");
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          <p className="text-label text-ink">
            {room.members?.find((m) => m.id === member.id)?.display_name ||
              member.id}
          </p>
          <code className="block break-all text-metadata text-ink">
            {member.fingerprint || "Encryption has not been set up yet."}
          </code>
          {member.fingerprint && (
            <>
              <Input
                label="Safety code received from this person"
                value={codes[member.id] || ""}
                onChange={(e) =>
                  setCodes({ ...codes, [member.id]: e.target.value })
                }
              />
              <Button type="submit" variant="secondary">
                Verify safety code
              </Button>
            </>
          )}
        </form>
      ))}
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
