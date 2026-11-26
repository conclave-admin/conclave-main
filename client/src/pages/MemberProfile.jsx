import { useEffect, useState } from "react";
import { Link, Navigate, useParams, useNavigate } from "react-router-dom";
import Page from "../components/layout/Page";
import Avatar from "../components/ui/Avatar";
import Button from "../components/ui/Button";
import Spinner from "../components/ui/Spinner";
import IconMessage from "../assets/icons/message.svg?react";
import IconGroup from "../assets/icons/group.svg?react";
import IconArrowLeft from "../assets/icons/arrow-left.svg?react";
import { useAuth } from "../contexts/AuthContext";
import { getProfile, getSharedRooms } from "../services/users.service";
import { createRoom } from "../services/rooms.service";

export default function MemberProfile() {
  const { userId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true });
  const [opening, setOpening] = useState(false);
  const [actionError, setActionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (userId === user?.id) return undefined;
    let active = true;
    setState({ loading: true });
    Promise.all([getProfile(userId), getSharedRooms(userId)])
      .then(([person, rooms]) => {
        if (active) setState({ person, rooms, userId });
      })
      .catch(() => {
        if (active)
          setState({
            error:
              "This profile is unavailable. You may no longer share a conversation.",
          });
      });
    return () => {
      active = false;
    };
  }, [userId, user?.id, attempt]);
  if (userId === user?.id) return <Navigate to="/profile" replace />;
  if (state.loading || (state.person && state.userId !== userId))
    return <Spinner label="Loading profile" />;
  return (
    <Page width="form">
      <Link
        to="/chats"
        className="mb-3 inline-flex min-h-11 items-center gap-2 text-label text-brand hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <IconArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to chats
      </Link>
      {state.error ? (
        <section
          role="alert"
          className="rounded-2xl border border-line bg-surface p-6"
        >
          <p>{state.error}</p>
          <Button
            className="mt-4"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </Button>
        </section>
      ) : (
        <>
          <section className="profile-identity rounded-2xl border border-line bg-surface p-4 md:p-5">
            <div className="flex min-w-0 items-center gap-4">
              <div className="shrink-0 rounded-full border-2 border-brand-soft bg-surface">
                <Avatar
                  size="lg"
                  name={state.person.display_name}
                  src={state.person.avatar_url}
                />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-h1 text-ink [overflow-wrap:anywhere]">
                  {state.person.display_name}
                </h1>
                <p className="mt-1 text-metadata text-muted">Conclave member</p>
              </div>
              <Button
                className="shrink-0 gap-2"
                disabled={opening}
                onClick={async () => {
                  setOpening(true);
                  setActionError("");
                  try {
                    const room = await createRoom({
                      type: "dm",
                      memberIds: [userId],
                    });
                    navigate(`/chats/${room.id}`);
                  } catch {
                    setActionError(
                      "Could not open this conversation. Try again.",
                    );
                  } finally {
                    setOpening(false);
                  }
                }}
              >
                <IconMessage className="h-5 w-5" aria-hidden="true" />
                {opening ? "Opening…" : "Message"}
              </Button>
            </div>
            {actionError && (
              <p role="alert" className="mt-3 text-error">
                {actionError}
              </p>
            )}
          </section>
          {state.person.bio && (
            <section className="mt-5 rounded-2xl border border-line bg-surface p-5">
              <h2 className="text-label text-muted">About</h2>
              <p className="mt-2 whitespace-pre-wrap break-words text-body text-ink">
                {state.person.bio}
              </p>
            </section>
          )}
          <section className="mt-5 overflow-hidden rounded-2xl border border-line bg-surface">
            <h2 className="flex items-center gap-2 px-5 py-4 text-h2">
              <IconGroup className="h-5 w-5 text-muted" aria-hidden="true" />
              Groups in common{" "}
              <span className="ml-auto text-label text-muted">
                {state.rooms.length}
              </span>
            </h2>
            {state.rooms.length ? (
              <ul className="divide-y divide-line border-t border-line">
                {state.rooms.map((room) => (
                  <li key={room.id}>
                    <Link
                      to={`/chats/${room.id}`}
                      className="flex min-h-14 items-center gap-3 px-5 py-2.5 hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/30"
                    >
                      <Avatar
                        name={room.display_name || room.name}
                        src={room.avatar_url}
                      />
                      <span className="truncate text-body">
                        {room.display_name || room.name}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 pb-5 text-body text-muted">
                No groups in common
              </p>
            )}
          </section>
        </>
      )}
    </Page>
  );
}
