import IconFailed from "@/assets/icons/failed.svg?react";
import IconPending from "@/assets/icons/pending.svg?react";
import IconRead from "@/assets/icons/read.svg?react";
import IconSent from "@/assets/icons/sent.svg?react";

const TICKS = {
  pending: { Icon: IconPending, label: "Sending" },
  queued: { Icon: IconPending, label: "Waiting for connection" },
  sent: { Icon: IconSent, label: "Sent" },
  delivered: { Icon: IconRead, label: "Delivered" },
  read: { Icon: IconRead, label: "Read" },
  failed: { Icon: IconFailed, label: "Failed to send" },
};

export default function MessageStatus({ status }) {
  if (!TICKS[status]) return null;
  const { Icon, label } = TICKS[status];
  const queued = status === "queued";
  return (
    <span
      data-message-status={status}
      title={queued ? "Not sent. Waiting for an internet connection." : label}
      aria-label={label}
      className={`inline-flex shrink-0 items-center gap-1 ${status === "failed" ? "text-error" : status === "read" ? "text-brand" : queued ? "text-warning" : "text-muted"}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{label}</span>
      {queued && (
        <span className="text-[10px] font-medium leading-none">Not sent</span>
      )}
    </span>
  );
}
