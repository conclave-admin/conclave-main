import Avatar from "@/components/ui/Avatar";
import Modal from "@/components/ui/Modal";
import IconCall from "@/assets/icons/call.svg?react";
import IconEndCall from "@/assets/icons/end-call.svg?react";
import IconMic from "@/assets/icons/mic.svg?react";
import IconMicOff from "@/assets/icons/mic-off.svg?react";
import IconVideo from "@/assets/icons/video.svg?react";
import IconVideoOff from "@/assets/icons/video-off.svg?react";

function clock(seconds = 0) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export default function CallPanel({ call, muted, cameraOff, duration, remoteStreams, localStream, localVideoRef, onAccept, onDecline, onEnd, onToggleMute, onToggleCamera }) {
  const incoming = call?.direction === "incoming" && call.status === "ringing";
  const remote = Object.values(remoteStreams || {});
  const status = !call ? "" : call.status === "ringing" ? "Calling…" : call.status === "active" ? clock(duration) : "Connecting…";
  return (
    <>
      {call?.callType !== "video" && remote.map(({ stream, peer }) => (
        <audio key={peer.id} autoPlay playsInline aria-label={`Call audio from ${peer.display_name}`} ref={(element) => { if (element && element.srcObject !== stream) { element.srcObject = stream; element.play().catch(() => {}); } }} />
      ))}
      {incoming ? (
        <Modal open title={call.callType === "video" ? "Incoming video call" : "Incoming voice call"} closeDisabled size="sm">
          <div className="flex flex-col items-center py-3 text-center">
            <Avatar name={call.peer?.display_name} src={call.peer?.avatar_url} size="lg" />
            <p className="mt-4 text-h2 text-ink">{call.peer?.display_name || "Conclave member"}</p>
            <p className="mt-1 text-body text-muted">{call.roomName ? `${call.roomName} · ` : ""}Incoming {call.callType === "video" ? "video" : "voice"} call</p>
            <div className="mt-7 flex w-full justify-center gap-4">
              <button type="button" onClick={onDecline} className="flex min-h-12 items-center gap-2 rounded-full bg-error px-5 text-label font-semibold text-white">
                <IconEndCall className="h-5 w-5" aria-hidden="true" /> Decline
              </button>
              <button type="button" onClick={onAccept} className="flex min-h-12 items-center gap-2 rounded-full bg-success px-5 text-label font-semibold text-white">
                <IconCall className="h-5 w-5" aria-hidden="true" /> Answer
              </button>
            </div>
          </div>
        </Modal>
      ) : call ? (
        <section aria-label={call.callType === "video" ? "Video call" : "Voice call"} className={`fixed bottom-20 right-4 z-50 w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-4 shadow-xl md:bottom-6 ${call.callType === "video" ? "md:w-[min(42rem,calc(100vw-3rem))]" : "md:w-[min(22rem,calc(100vw-2rem))]"}`}>
          <div className="flex items-center gap-3">
            {call.peers?.length === 1 && <Avatar name={call.peers[0].display_name} src={call.peers[0].avatar_url} size="md" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-label font-semibold text-ink">{call.peers?.length > 1 ? call.roomName || "Group call" : call.peers?.[0]?.display_name || "Conclave member"}</p>
              <p className="text-metadata text-muted" aria-live="polite">{status} · {call.callType === "video" ? "Video call" : "Voice call"}</p>
            </div>
          </div>
          {call.callType === "video" && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {remote.map(({ stream, peer }) => (
                <video key={peer.id} autoPlay playsInline aria-label={`${peer.display_name} on camera`} ref={(element) => { if (element && element.srcObject !== stream) { element.srcObject = stream; element.play().catch(() => {}); } }} className="aspect-video w-full rounded-lg bg-ink object-cover" />
              ))}
              {!remote.length && <div className="col-span-2 grid aspect-video place-items-center rounded-lg bg-canvas text-metadata text-muted">Waiting for others to join</div>}
            </div>
          )}
          {call.callType === "video" && localStream && (
            <video ref={localVideoRef} autoPlay playsInline muted aria-label="Your camera" className="absolute right-6 top-16 h-20 w-28 rounded-lg border-2 border-surface bg-ink object-cover shadow-lg" />
          )}
          {call.callType === "audio" && call.peers?.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Call participants">
              {call.peers.map((peer) => <span key={peer.id} className="flex items-center gap-2 rounded-full bg-canvas px-3 py-2 text-label text-ink"><Avatar name={peer.display_name} src={peer.avatar_url} size="sm" />{peer.display_name}</span>)}
            </div>
          )}
          <div className="mt-4 flex justify-center gap-3">
            {call.status !== "ringing" && (
              <button type="button" onClick={onToggleMute} aria-pressed={muted} aria-label={muted ? "Turn microphone on" : "Mute microphone"} className="grid h-12 w-12 place-items-center rounded-full border border-line text-ink hover:bg-canvas">
                {muted ? <IconMicOff className="h-5 w-5" aria-hidden="true" /> : <IconMic className="h-5 w-5" aria-hidden="true" />}
              </button>
            )}
            {call.callType === "video" && call.status !== "ringing" && (
              <button type="button" onClick={onToggleCamera} aria-pressed={cameraOff} aria-label={cameraOff ? "Turn camera on" : "Turn camera off"} className="grid h-12 w-12 place-items-center rounded-full border border-line text-ink hover:bg-canvas">
                {cameraOff ? <IconVideoOff className="h-5 w-5" aria-hidden="true" /> : <IconVideo className="h-5 w-5" aria-hidden="true" />}
              </button>
            )}
            <button type="button" onClick={onEnd} aria-label="Leave call" className="grid h-12 w-12 place-items-center rounded-full bg-error text-white hover:brightness-95">
              <IconEndCall className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
