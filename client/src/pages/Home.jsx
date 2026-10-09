import { useAuth } from "../contexts/AuthContext";
import { isDevAuthBypass } from "../config/devPreview";
import Message from "../components/chat/Message";

const metrics = [
  { previewValue: "5", label: "unread messages", color: "text-brand" },
  { previewValue: "2", label: "new decisions", color: "text-success" },
  { previewValue: "3", label: "tasks due", color: "text-warning" },
];

const previewActivity = [
  {
    id: "activity-amina-decision",
    author: "Amina",
    timestamp: "10:07 AM",
    content:
      "After testing both approaches, we'll keep Socket.IO for real-time events and REST for CRUD.",
  },
  {
    id: "activity-victor",
    author: "Victor",
    timestamp: "10:17 AM",
    content:
      "Sounds good. This keeps our real-time path focused and reduces operational overhead.",
  },
  {
    id: "activity-amina-mention",
    author: "Amina",
    timestamp: "10:27 AM",
    content:
      "@Priya can you confirm deployment readiness for the API gateway changes today?",
    variant: "mention",
  },
  {
    id: "activity-priya",
    author: "Priya",
    timestamp: "10:37 AM",
    content: "On it—validating the config and will update here by EOD.",
  },
  {
    id: "activity-daniel",
    author: "Daniel",
    timestamp: "10:47 AM",
    content:
      "Uploaded the latest checklist with the rollback steps and verification items.",
    variant: "file-attachment",
    attachments: [
      { id: "preview-attachment", filename: "deployment-checklist-v2.pdf" },
    ],
  },
];

function MetricCard({ metric }) {
  return (
    <article className="h-28 rounded-xl border border-line bg-surface px-5 pt-18">
      <strong className={`text-h1 ${metric.color}`}>
        {isDevAuthBypass ? metric.previewValue : "0"}
      </strong>
      <p className="mt-2.5 text-body text-muted">{metric.label}</p>
    </article>
  );
}

function ActivityRows() {
  if (!isDevAuthBypass)
    return (
      <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
        <p className="text-sm font-medium text-ink">Nothing new yet</p>
        <p className="mt-1 text-sm text-muted">
          Open a room to continue the conversation.
        </p>
      </div>
    );
  // 16px verified as a true flow gap on Room View Mobile (varying row heights,
  // constant gap). Tablet/Desktop rows sit in a fixed 100px slot regardless of
  // content height, so their apparent "57px gap" is a mockup artifact, not a
  // real value — 16px applies uniformly instead.
  return (
    <div className="space-y-4">
      {previewActivity.map((item) => (
        <Message
          key={item.id}
          variant={item.variant || "default"}
          author={item.author}
          timestamp={item.timestamp}
          content={item.content}
          attachments={item.attachments}
        />
      ))}
    </div>
  );
}

export default function Home() {
  const { user } = useAuth();
  const firstName = user?.display_name?.split(" ")[0] || "there";
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface px-4 pt-7">
      <div className="max-w-[1140px]">
        <div className="px-3">
          <h1 className="text-h1">Good morning, {firstName}</h1>
          <p className="mt-2 text-body text-muted">
            Here’s what changed while you were away.
          </p>
        </div>
        {/* md matches the Tablet board (2-col, 18px column-gap/20px row-gap);
        lg matches Desktop (3-col, 18px gap). 33px top margin measured on both
        boards — not on the Foundations spacing scale, hence the arbitrary value. */}
        <div className="mt-8 grid grid-cols-1 gap-5 md:mt-[33px] md:grid-cols-2 md:gap-x-18 md:gap-y-5 lg:grid-cols-3 lg:gap-18">
          {metrics.map((metric) => (
            <MetricCard key={metric.label} metric={metric} />
          ))}
        </div>
        <section className="mt-8 px-3 md:mt-14">
          <h2 className="text-h2">Recent activity</h2>
          {/* 28px measured on both Tablet and Desktop boards — matches base mt-7, no md: override needed. */}
          <div className="mt-7">
            <ActivityRows />
          </div>
        </section>
      </div>
    </div>
  );
}
