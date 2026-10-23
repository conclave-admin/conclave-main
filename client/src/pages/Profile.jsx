import { useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import IconCamera from "@/assets/icons/camera.svg?react";
import IconDelete from "@/assets/icons/delete.svg?react";
import IconSignOut from "@/assets/icons/sign-out.svg?react";
import Avatar from "@/components/ui/Avatar";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import Textarea from "@/components/ui/Textarea";
import { useAuth } from "@/contexts/AuthContext";
import { useChats } from "@/contexts/ChatsContext";
import { useToast } from "@/contexts/ToastContext";
import { uploadAvatar } from "@/services/users.service";
import Page from "@/components/layout/Page";

/**
 * Profile — the signed-in user's own account.
 *
 * Three editable fields, and only three: `PATCH /users/me` whitelists
 * display_name, avatar_url and bio. Email and password are deliberately absent
 * rather than disabled — there are no endpoints for either, and a greyed-out
 * "Change email" is a promise the product cannot keep.
 *
 * The avatar is a two-step save, upload then PATCH. It cannot be one call: the
 * upload endpoint returns a URL and knows nothing about profiles, while the
 * profile endpoint takes a URL and knows nothing about files. Uploading on pick
 * rather than on submit matches the composer, so a failure is visible before the
 * form is committed rather than after.
 *
 * @param {object} props
 */
export default function Profile() {
  const { setRoomHeader } = useOutletContext();
  const { user, logout, updateProfile, deleteAccount } = useAuth();
  const { rooms = [], unreadTotal = 0 } = useChats();
  const { toast } = useToast();
  const fileRef = useRef(null);

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setRoomHeader("Profile");
    return () => setRoomHeader(null);
  }, [setRoomHeader]);

  // Seed the form from the context user once it exists, rather than on mount:
  // under the real API this page can render before /users/me resolves.
  useEffect(() => {
    if (!user) return;
    setDisplayName(user.display_name || "");
    setBio(user.bio || "");
    setAvatarUrl(user.avatar_url || null);
  }, [user]);

  const nameChanged = displayName.trim() !== (user?.display_name || "");
  const bioChanged = bio !== (user?.bio || "");
  const isDirty = nameChanged || bioChanged;
  const dmCount = rooms.filter((room) => room.type === "dm").length;
  const roomCount = rooms.filter((room) => room.type !== "dm").length;

  const memberSince = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      })
    : "—";

  async function onPickAvatar(event) {
    const file = event.target.files?.[0];
    // Reset first: picking the same file twice in a row fires no change event
    // otherwise, so a failed upload could not be retried with the same image.
    event.target.value = "";
    if (!file) return;

    setIsUploading(true);
    try {
      const url = await uploadAvatar(file);
      setAvatarUrl(url);
      await updateProfile({ avatar_url: url });
      toast({ title: "Photo updated", tone: "success" });
    } catch (err) {
      toast({
        title: "Upload failed",
        description:
          err.response?.data?.message || "Could not upload that image.",
        tone: "error",
      });
    } finally {
      setIsUploading(false);
    }
  }

  async function onSave(event) {
    event.preventDefault();
    setIsSaving(true);
    try {
      await updateProfile({ display_name: displayName.trim(), bio });
      toast({ title: "Profile saved", tone: "success" });
    } catch (err) {
      toast({
        title: "Could not save",
        description:
          err.response?.data?.message || "Your profile was not updated.",
        tone: "error",
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function onConfirmDelete() {
    try {
      await deleteAccount();
      setConfirmDelete(false);
    } catch (err) {
      toast({
        title: "Could not delete",
        description:
          err.response?.data?.message || "Your account was not deleted.",
        tone: "error",
      });
    }
  }

  return (
    <Page width="content">
      <div>
        <h1 className="text-h1 text-ink">Your profile</h1>
        <p className="mt-2 text-body leading-relaxed text-muted">
          Your identity and account details across your conversations.
        </p>
      </div>

      <section
        className="mt-6 rounded-2xl border border-line bg-surface p-5 shadow-card md:p-7"
        aria-label="Profile preview"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar
            name={displayName || user?.display_name}
            src={avatarUrl}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-h2 text-ink">
              {displayName || user?.display_name || "Your name"}
            </h2>
            <p className="mt-1 truncate text-body text-muted">
              {user?.email || "Email unavailable"}
            </p>
            <p className="mt-3 whitespace-pre-wrap text-body leading-relaxed text-ink">
              {bio.trim() ||
                "Add a short introduction so people know who they are talking to."}
            </p>
          </div>
          <div className="shrink-0 rounded-xl bg-canvas px-4 py-3 text-left sm:text-right">
            <p className="text-metadata text-muted">Member since</p>
            <p className="mt-1 text-label text-ink">{memberSince}</p>
          </div>
        </div>
      </section>

      <section
        className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4"
        aria-label="Account overview"
      >
        <ProfileStat label="Conversations" value={rooms.length} />
        <ProfileStat label="Direct messages" value={dmCount} />
        <ProfileStat label="Rooms" value={roomCount} />
        <ProfileStat label="Unread messages" value={unreadTotal} />
      </section>

      <section className="mt-8 rounded-2xl border border-line bg-surface p-5 md:p-7">
        <div>
          <h2 className="text-h2 text-ink">Edit your profile</h2>
          <p className="mt-1 text-body text-muted">
            This is the name, photo, and introduction other members see.
          </p>
        </div>

        <section className="mt-6 flex flex-wrap items-center gap-4">
          <Avatar name={displayName} src={avatarUrl} size="lg" />
          <div className="min-w-0">
            <Button
              variant="secondary"
              onClick={() => fileRef.current?.click()}
              disabled={isUploading}
              className="gap-2"
            >
              <IconCamera className="h-4 w-4" aria-hidden="true" />
              {isUploading ? "Uploading…" : "Change photo"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={onPickAvatar}
              className="sr-only"
              aria-label="Upload a profile photo"
            />
            <p className="mt-2 text-metadata text-muted">
              PNG, JPEG, WebP or GIF.
            </p>
          </div>
        </section>

        <form onSubmit={onSave} className="mt-6 grid gap-5 md:grid-cols-2">
          <Input
            label="Display name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={100}
            required
          />
          <div>
            <Input
              label="Email address"
              value={user?.email || "—"}
              readOnly
              disabled
            />
            <p className="mt-1 text-metadata text-muted">
              Email is used to sign in and is only shown here to you.
            </p>
          </div>
          <Textarea
            className="md:col-span-2"
            label="About"
            value={bio}
            onChange={(event) => setBio(event.target.value)}
            maxLength={1000}
            placeholder="A line about what you work on"
          />

          <div className="flex flex-wrap items-center gap-3 md:col-span-2">
            <Button
              type="submit"
              disabled={!isDirty || isSaving || !displayName.trim()}
            >
              {isSaving ? "Saving…" : "Save changes"}
            </Button>
            {isDirty && !isSaving && (
              <span className="text-metadata text-muted">Unsaved changes</span>
            )}
          </div>
        </form>
      </section>

      <section className="mt-8">
        <Button variant="secondary" onClick={logout} className="gap-2">
          <IconSignOut className="h-4 w-4" aria-hidden="true" />
          Log out
        </Button>
      </section>

      <section className="mt-12 border-t border-line pt-8">
        <h2 className="text-h2 text-error">Danger zone</h2>
        <p className="mt-2 text-body leading-relaxed text-muted">
          Deleting your account removes your name, email and every room you are
          in. Your messages and decisions stay, shown as “Deleted user”. This
          cannot be undone.
        </p>
        <Button
          variant="secondary"
          onClick={() => setConfirmDelete(true)}
          className="mt-4 gap-2 border-error text-error hover:bg-error/5"
        >
          <IconDelete className="h-4 w-4" aria-hidden="true" />
          Delete account
        </Button>
      </section>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete your account?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={onConfirmDelete}
              className="border-error bg-error text-surface hover:bg-error/90"
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p className="text-body leading-relaxed text-muted">
          You will be signed out on every device. Your email address is
          released, so it can be registered again — but nothing you wrote comes
          back with it.
        </p>
      </Modal>
    </Page>
  );
}

function ProfileStat({ label, value }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <p className="text-metadata text-muted">{label}</p>
      <p className="mt-1 text-h2 tabular-nums text-ink">{value}</p>
    </div>
  );
}
