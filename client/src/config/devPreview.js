export const isDevAuthBypass =
  import.meta.env.DEV && import.meta.env.VITE_DEV_AUTH_BYPASS === "true";

export const previewUser = {
  id: "dev-preview-user",
  email: "amina@conclave.local",
  display_name: "Amina Yusuf",
  avatar_url: null,
  bio: "Frontend preview account",
};

// Mirrors one row of the enriched `GET /rooms` response (docs/API_CONTRACTS.md,
// "The chat-list row"). display_name/display_avatar/last_message/unread_count
// are the fields phase 1 added; without them the chat list renders empty
// previews in bypass mode and the whole phase becomes unverifiable offline.
// A second, DM-shaped room is included so the DMs filter chip has something to
// filter to.
export const previewRoom = {
  id: "preview-room",
  name: "Product & Engineering",
  slug: "product-eng",
  type: "group",
  member_count: 4,
  my_role: "admin",
  last_seen_at: "2026-10-08T08:00:00.000Z",
  display_name: "Product & Engineering",
  display_avatar: null,
  has_message: true,
  unread_count: 3,
  last_message: {
    id: "dev-last-1",
    content: "On it—validating the config and update by EOD.",
    sender_id: "dev-priya",
    sender_name: "Priya",
    sender_avatar: null,
    has_attachment: false,
    is_deleted: false,
    created_at: "2026-10-08T09:37:00.000Z",
  },
// `GET /rooms/:roomId` returns members in a richer shape than the chat-list
// row: role, joined_at and last_seen_at. last_seen_at is the per-member read
// pointer the delivery ticks are derived from, so without it every own message
// in bypass mode renders permanently "Sent" and the whole tick feature is
// unverifiable offline. last_seen_at is deliberately stale for Victor so his
// messages read as unread and the tick can be seen changing.
  members: [
    { ...previewUser, role: 'admin', last_seen_at: '2026-10-08T09:50:00.000Z' },
    { id: 'dev-victor', display_name: 'Victor', avatar_url: null, role: 'member', last_seen_at: '2026-08-27T09:00:00.000Z' },
    { id: 'dev-priya', display_name: 'Priya', avatar_url: null, role: 'member', last_seen_at: '2026-10-08T09:45:00.000Z' },
    { id: 'dev-daniel', display_name: 'Daniel', avatar_url: null, role: 'member', last_seen_at: '2026-10-08T09:49:00.000Z' },
  ],
};

export const previewDmRoom = {
  id: "preview-dm",
  name: "Victor",
  slug: null,
  type: "dm",
  member_count: 2,
  my_role: "member",
  last_seen_at: "2026-10-08T10:00:00.000Z",
  // For a DM the backend returns the OTHER member's identity, not the room
  // title — that is the whole point of display_name.
  display_name: "Victor",
  display_avatar: null,
  has_message: true,
  unread_count: 0,
  last_message: {
    id: "dev-last-2",
    content: "Sending the deck over now.",
    sender_id: "dev-victor",
    sender_name: "Victor",
    sender_avatar: null,
    has_attachment: true,
    is_deleted: false,
    created_at: "2026-10-08T09:52:00.000Z",
  },
  members: [
    { ...previewUser, role: 'admin', last_seen_at: '2026-10-08T10:00:00.000Z' },
    { id: 'dev-victor', display_name: 'Victor', avatar_url: null, role: 'member', last_seen_at: '2026-10-08T09:52:00.000Z' },
  ],
};

// Each field below corresponds to something phase 5 renders: `reactions` to the
// chip row and picker, `edited_at` to the "edited" label, `is_deleted` to the
// tombstone, `reply_to_id` to the reply preview, and `mentioned_user_ids` to the
// @highlight — which is recorded, not inferred, so it is shown as data rather
// than re-parsed out of the text.
export const previewMessages = [
  {
    id: "dev-message-1",
    room_id: previewRoom.id,
    sender_id: previewUser.id,
    sender_name: "Amina Yusuf",
    sender_avatar: null,
    content:
      "After testing both approaches, we'll keep Socket.IO for real-time events and REST for CRUD.",
    reactions: [
      { emoji: '👍', count: 2, reacted: true },
      { emoji: '🎉', count: 1, reacted: false },
    ],
    mentioned_user_ids: [],
    is_deleted: false,
    edited_at: null,
    reply_to_id: null,
    created_at: "2026-08-27T09:07:00.000Z",
  },
  {
    id: "dev-message-2",
    room_id: previewRoom.id,
    sender_id: "dev-victor",
    sender_name: "Victor",
    sender_avatar: null,
    content:
      "Sounds good. This keeps our real-time path focused and reduces operational overhead.",
    reactions: [],
    mentioned_user_ids: [],
    is_deleted: false,
    edited_at: null,
    reply_to_id: null,
    created_at: "2026-08-27T09:17:00.000Z",
  },
  {
    id: "dev-message-3",
    room_id: previewRoom.id,
    sender_id: previewUser.id,
    sender_name: "Amina Yusuf",
    sender_avatar: null,
    content:
      "@Priya can you confirm deployment readiness for the API gateway changes today?",
    reactions: [],
    // The id, not the name: a mention means one person, and display names are
    // not unique — two Priyas would both be notified by a name-only mention.
    mentioned_user_ids: ["dev-priya"],
    is_deleted: false,
    // An edit that changed the text, so the "edited" label has something to
    // describe. The timestamp is still the original creation time.
    edited_at: "2026-08-27T09:31:00.000Z",
    reply_to_id: null,
    created_at: "2026-08-27T09:27:00.000Z",
  },
  {
    id: "dev-message-4",
    room_id: previewRoom.id,
    sender_id: "dev-priya",
    sender_name: "Priya",
    sender_avatar: null,
    content: "On it—validating the config and will update here by EOD.",
    reactions: [{ emoji: '✅', count: 1, reacted: false }],
    mentioned_user_ids: [],
    is_deleted: false,
    edited_at: null,
    // A reply, so the preview bar and the in-timeline quote both render.
    reply_to_id: "dev-message-3",
    created_at: "2026-08-27T09:37:00.000Z",
  },
  {
    id: "dev-message-5",
    room_id: previewRoom.id,
    sender_id: "dev-victor",
    sender_name: "Victor",
    sender_avatar: null,
    content: "Here's the Q3 performance report.",
    reactions: [],
    mentioned_user_ids: [],
    is_deleted: false,
    edited_at: null,
    reply_to_id: null,
    attachments: [
      {
        id: "dev-att-1",
        filename: "Q3-perf-report.pdf",
        size: 245760,
        mime_type: "application/pdf",
        url: "https://placehold.co/800x1100?text=Q3+Report",
      },
    ],
    created_at: "2026-08-27T09:42:00.000Z",
  },
  {
    id: "dev-message-6",
    room_id: previewRoom.id,
    sender_id: previewUser.id,
    sender_name: "Amina Yusuf",
    sender_avatar: null,
    content: "Screenshot from the staging deploy:",
    reactions: [{ emoji: '👍', count: 1, reacted: false }],
    mentioned_user_ids: [],
    is_deleted: false,
    edited_at: null,
    reply_to_id: null,
    attachments: [
      {
        id: "dev-att-2",
        filename: "staging-deploy.png",
        size: 184320,
        mime_type: "image/png",
        url: "https://placehold.co/1200x800?text=Staging+Deploy",
      },
    ],
    created_at: "2026-08-27T09:45:00.000Z",
  },
  {
    id: "dev-message-7",
    room_id: previewRoom.id,
    sender_id: "dev-daniel",
    sender_name: "Daniel",
    sender_avatar: null,
    content: "",
    reactions: [],
    mentioned_user_ids: [],
    is_deleted: false,
    edited_at: null,
    reply_to_id: null,
    attachments: [
      {
        id: "dev-att-3",
        filename: "api-spec-v2.zip",
        size: 1048576,
        mime_type: "application/zip",
        url: "https://placehold.co/400x300?text=api-spec-v2.zip",
      },
      {
        id: "dev-att-4",
        filename: "changelog.md",
        size: 4096,
        mime_type: "text/markdown",
        url: "https://placehold.co/600x400?text=changelog.md",
      },
    ],
    created_at: "2026-08-27T09:48:00.000Z",
  },
  // A tombstone. Deleted messages are kept in the list by the server as a
  // soft delete, so rendering nothing here would make a conversation jump
  // together with no sign that something was removed.
  {
    id: "dev-message-8",
    room_id: previewRoom.id,
    sender_id: "dev-victor",
    sender_name: "Victor",
    sender_avatar: null,
    content: "",
    reactions: [],
    mentioned_user_ids: [],
    is_deleted: true,
    edited_at: null,
    reply_to_id: null,
    created_at: "2026-08-27T09:50:00.000Z",
  },
];

// Mirrors the `decisions` table (backend/database/migrations/002_decisions_tasks_digest.sql).
// Same architectural gap as previewDigestSummary/previewDigestItems below: /decisions and
// /digest are both top-level, cross-room pages in the design, but their only backend
// endpoints (/decisions/room/:roomId, /digest/room/:roomId — see decisions.controller.js
// and digest.controller.js, both TODO stubs) are room-scoped. Neither can list "across
// every room I'm in" yet — that's what the backend needs to add. room_name/room_slug
// below are join fields such an endpoint would need to return; rooms has no slug column,
// so this is display-only, same convenience as sender_name on previewMessages.
// `pins` mirrors the wire shape decisionPin.service.attachPins builds: `room` is
// shared truth (one pinner, same for everyone), `mine` is the viewer's own scopes
// and is a list because a decision can be both room-pinned and bookmarked. The
// three entries below cover one of each state so the strip can be read at a
// glance: room-pinned, bookmarked only, and neither.
export const previewDecisions = [
  {
    id: "dev-decision-1",
    room_id: previewRoom.id,
    room_name: previewRoom.name,
    room_slug: "product-eng",
    source_message_id: "dev-message-1",
    title: "Use Socket.IO for real-time events; REST handles CRUD.",
    body: "After testing both approaches, we'll keep Socket.IO for real-time events and REST for CRUD endpoints.",
    tags: [],
    created_by: "dev-victor",
    author_name: "Victor",
    created_at: "2026-08-20T00:00:00.000Z",
    pins: {
      room: { user_id: previewUser.id, display_name: previewUser.display_name, pinned_at: '2026-10-08T09:00:00.000Z' },
      mine: ['user', 'room'],
    },
  },
  {
    id: "dev-decision-2",
    room_id: "dev-room-marketing",
    room_name: "Marketing",
    room_slug: "marketing",
    source_message_id: null,
    title: "Ship upload limits with plan-aware validation.",
    body: "Free plan caps at 25MB per file; paid plans scale with storage tier.",
    tags: [],
    created_by: "dev-victor",
    author_name: "Victor",
    created_at: "2026-08-19T00:00:00.000Z",
    pins: { room: null, mine: [] },
  },
  {
    id: "dev-decision-3",
    room_id: "dev-room-design-crit",
    room_name: "Design Crit",
    room_slug: "design-crit",
    source_message_id: null,
    title: "Keep deployment approvals inside private rooms.",
    body: "Approval threads stay out of the public activity feed to avoid noise.",
    tags: [],
    created_by: "dev-victor",
    author_name: "Victor",
    created_at: "2026-08-18T00:00:00.000Z",
    pins: { room: null, mine: [] },
  },
];

// Mirrors the digest the backend would assemble from decisions/tasks/messages/attachments
// (see getRoomDigest's TODO comments in digest.controller.js) and cache in the `digests`
// table (room_id, user_id, period_start, period_end, content_json). Same cross-room gap as
// previewDecisions above: only /digest/room/:roomId exists, nothing aggregates across a
// user's rooms yet, even though /digest is a top-level page in the design.
export const previewDigestSummary = {
  headline: "5 meaningful updates",
  summary: "One decision, two task changes, a mention, and a shared file.",
};

// `type` only — no label/colour here. That's presentation, not data: the backend will
// send a type, not display copy, so the type-to-label/colour mapping lives in
// CatchUpDigestPage.jsx instead.
export const previewDigestItems = [
  { id: "dev-digest-1", type: "decision", title: "Keep Socket.IO focused on real-time events; REST handles CRUD.", metadata: "Today · 9:02 AM" },
  { id: "dev-digest-2", type: "task", title: "Daniel, confirm production upload limits.", metadata: "Today · 10:12 AM" },
  { id: "dev-digest-3", type: "mention", title: "Amina mentioned you in #deployments.", metadata: "Today · 11:22 AM" },
  { id: "dev-digest-4", type: "file", title: "deployment-checklist-v2.pdf", metadata: "Today · 12:32 AM" },
  { id: "dev-digest-5", type: "activity", title: "7 messages in #product-eng", metadata: "Today · 1:42 PM" },
];

// Mirrors the `tasks` table (backend/database/migrations/002_decisions_tasks_digest.sql).
// /tasks/room/:roomId, POST /tasks, and PATCH /tasks/:taskId/status all exist
// (tasks.routes.js) but are TODO stubs (tasks.controller.js). `status` already matches
// the board's three columns 1:1 ('open'|'in_progress'|'done'), no extra mapping needed.
// assignee_name is a join field the real endpoint would need to return, same convenience
// as sender_name/author_name elsewhere in this file.
export const previewTasks = [
  { id: "dev-task-1", room_id: previewRoom.id, status: "open", title: "Confirm production upload limits", assignee_id: "dev-priya", assignee_name: "Priya", due_date: "2026-08-22" },
  { id: "dev-task-2", room_id: previewRoom.id, status: "open", title: "Validate deployment config", assignee_id: "dev-victor", assignee_name: "Victor", due_date: "2026-08-23" },
  { id: "dev-task-3", room_id: previewRoom.id, status: "open", title: "Review storage alerts", assignee_id: "dev-victor", assignee_name: "Victor", due_date: "2026-08-24" },
  { id: "dev-task-4", room_id: previewRoom.id, status: "in_progress", title: "Draft API rate-limit docs", assignee_id: previewUser.id, assignee_name: "Amina", due_date: "2026-08-21" },
  { id: "dev-task-5", room_id: previewRoom.id, status: "in_progress", title: "Wire Socket.IO reconnect handling", assignee_id: "dev-daniel", assignee_name: "Daniel", due_date: "2026-08-25" },
  { id: "dev-task-6", room_id: previewRoom.id, status: "done", title: "Set up staging environment", assignee_id: "dev-victor", assignee_name: "Victor", due_date: "2026-08-18" },
  { id: "dev-task-7", room_id: previewRoom.id, status: "done", title: "Migrate auth middleware to JWT", assignee_id: previewUser.id, assignee_name: "Amina", due_date: "2026-08-19" },
  { id: "dev-task-8", room_id: previewRoom.id, status: "done", title: "Write onboarding checklist", assignee_id: "dev-priya", assignee_name: "Priya", due_date: "2026-08-19" },
  { id: "dev-task-9", room_id: previewRoom.id, status: "done", title: "Fix flaky websocket reconnect test", assignee_id: "dev-daniel", assignee_name: "Daniel", due_date: "2026-08-20" },
  { id: "dev-task-10", room_id: previewRoom.id, status: "done", title: "Ship upload size validation", assignee_id: "dev-victor", assignee_name: "Victor", due_date: "2026-08-20" },
];

const listeners = new Map();
export const previewSocket = {
  connected: true,
  on(event, handler) {
    const handlers = listeners.get(event) || new Set();
    handlers.add(handler);
    listeners.set(event, handlers);
  },
  off(event, handler) {
    listeners.get(event)?.delete(handler);
  },
  emit(event, payload = {}) {
    // Typing is echoed back as room-typing so the indicator renders offline.
    // `stop-typing` is dropped deliberately: sending clears the sender's typing
    // state, and echoing it would put them straight back on the list.
    if (event === 'typing') {
      queueMicrotask(() =>
        listeners
          .get('room-typing')
          ?.forEach((handler) =>
            handler({ roomId: payload.roomId, typingUserIds: [previewUser.id] }),
          ),
      );
      return;
    }
    if (event === 'stop-typing') return;
    if (event !== 'send-message') return;

    const message = {
      id: `dev-message-${Date.now()}`,
      room_id: payload.roomId,
      sender_id: previewUser.id,
      sender_name: previewUser.display_name,
      sender_avatar: null,
      content: payload.content || '',
      // Carried through so an offline send with an attachment, a reply or a
      // mention still renders the way a real one would. Dropping them here
      // would make bypass mode agree with the wire only for plain text.
      attachments: payload.attachments || [],
      reply_to_id: payload.replyToId || null,
      mentioned_user_ids: payload.mentionedUserIds || [],
      reactions: [],
      is_deleted: false,
      edited_at: null,
      created_at: new Date().toISOString(),
    };
    queueMicrotask(() =>
      listeners
        .get('receive-message')
        ?.forEach((handler) => handler({ message })),
    );
  },
};
