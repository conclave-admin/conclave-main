const crypto = require("node:crypto");
const webpush = require("web-push");
const { pool } = require("../config/db");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");
const policy = require("./notificationPolicy.service");
const { preview: previewText } = require("./notification.service");
const { isQuietNow } = require("./quietHours");
const CALL_PUSH_TTL_SECONDS = 40;

// Opt-out rich content: sender/actor name, room, and a truncated message
// preview, grouped per conversation so several unread messages in one room
// update a single OS notification instead of stacking separately. Falls back
// to a fully generic payload when the recipient disabled previews, or when
// nothing safe to show is available (e.g. the subject itself is a
// not-otherwise-readable type) — never when content is merely absent, since a
// missing preview must look identical to an intentionally generic one.
function buildPayload(n, unseenCount) {
  // One OS notification per conversation *and kind*: several unread messages
  // in a room collapse into a single updating entry, while a task assignment
  // in the same room keeps its own entry instead of silently replacing the
  // message one (and vice versa).
  const messageTag = `conclave:room:${n.room_id}`;
  const kindTag = (kind) => `${messageTag}:${kind}`;
  const generic = {
    title: "Conclave",
    body: "You have new activity in Conclave",
    tag: messageTag,
  };
  // No saved row (NULL) means the default, which is enabled — the same
  // convention notification_preferences uses for push_enabled/activity_level.
  if (n.push_preview_enabled === false) return { ...generic, tag: kindTag(n.type) };

  const room = n.room_name || "a conversation";
  const isDm = n.room_type === "dm";
  const who = n.actor_name || n.sender_name || "Someone";

  if (["mention", "new_message", "file_uploaded", "reminder"].includes(n.type)) {
    if (unseenCount > 0) {
      return {
        // Grouped: the room (or the person, in a DM) is the headline and the
        // count is the body, so the entry reads at a glance like Slack's
        // collapsed stack rather than repeating the same sender per message.
        title: isDm ? who : room,
        body: `${unseenCount + 1} new message${unseenCount + 1 === 1 ? "" : "s"}${
          isDm ? "" : ` in ${room}`
        }`,
        tag: messageTag,
      };
    }
    const body =
      n.type === "file_uploaded"
        ? `${who} sent a file`
        : previewText(n.message_content) || `${who} sent a message`;
    return {
      title: isDm ? who : `${who} in ${room}`,
      body,
      tag: messageTag,
    };
  }
  if (n.type === "room_invite")
    return {
      title: room,
      body: `${who} invited you to ${room}`,
      tag: kindTag("invite"),
    };
  if (n.type === "member_joined")
    return {
      title: room,
      body: `${who} joined ${room}`,
      tag: kindTag("joined"),
    };
  if (n.type === "task")
    return {
      title: room,
      body: `${who} assigned you a task: ${n.task_title || "Untitled task"}`,
      tag: kindTag("task"),
    };
  if (n.type === "decision")
    return {
      title: room,
      body: `${who} updated a decision: ${n.decision_title || "Untitled decision"}`,
      tag: kindTag("decision"),
    };
  if (n.type === "event_reminder")
    return {
      title: room,
      body: `Upcoming event: ${n.event_title || "Room event"}`,
      tag: kindTag("event"),
    };
  if (n.type === "event_cancelled")
    return {
      title: room,
      body: `${who} cancelled ${n.event_title || "an event"}`,
      tag: kindTag("event"),
    };
  return { ...generic, tag: kindTag(n.type) };
}
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
function configured() {
  try {
    return (
      Buffer.from(env.push.publicKey || "", "base64url").length === 65 &&
      Buffer.from(env.push.privateKey || "", "base64url").length === 32 &&
      Boolean(env.push.subject) &&
      ["mailto:", "https:"].includes(new URL(env.push.subject).protocol)
    );
  } catch {
    return false;
  }
}
function validateSubscription(value) {
  if (
    !value ||
    typeof value.endpoint !== "string" ||
    value.endpoint.length > 2048
  )
    throw new ApiError(400, "Invalid push subscription");
  let url;
  try {
    url = new URL(value.endpoint);
  } catch {
    throw new ApiError(400, "Invalid push endpoint");
  }
  const host = url.hostname;
  const allowed = [
    "fcm.googleapis.com",
    "gcm-http.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
  ];
  const extra = env.push.allowedOrigins;
  if (
    url.protocol !== "https:" ||
    url.hash ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !(
      allowed.includes(host) ||
      host.endsWith(".push.services.mozilla.com") ||
      host.endsWith(".notify.windows.com") ||
      extra.includes(url.origin)
    )
  )
    throw new ApiError(400, "Unsupported push service");
  for (const [key, size] of [
    ["p256dh", 65],
    ["auth", 16],
  ]) {
    const text = value.keys?.[key];
    if (
      typeof text !== "string" ||
      !/^[A-Za-z0-9_-]+={0,2}$/.test(text) ||
      Buffer.from(text, "base64url").length !== size
    )
      throw new ApiError(400, "Invalid subscription encryption keys");
  }
  try {
    crypto.ECDH.convertKey(
      Buffer.from(value.keys.p256dh, "base64url"),
      "prime256v1",
    );
  } catch {
    throw new ApiError(400, "Invalid subscription encryption key");
  }
  return {
    endpoint: url.href,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
    expirationTime: value.expirationTime || null,
  };
}
async function upsert(db, userId, sessionId, sub, bindingId) {
  const renewal = crypto.randomBytes(32).toString("base64url");
  const session = await db.query(
    `SELECT s.expires_at FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>NOW() AND u.deleted_at IS NULL FOR SHARE OF s,u`,
    [sessionId, userId],
  );
  if (!session.rows.length) throw new ApiError(401, "Push session expired");
  const count = await db.query(
    "SELECT COUNT(*)::int AS count FROM push_subscriptions WHERE user_id=$1 AND endpoint<>$2",
    [userId, sub.endpoint],
  );
  if (count.rows[0].count >= 20)
    throw new ApiError(
      409,
      "Too many push subscriptions; disable an older browser first",
    );
  const result = await db.query(
    `INSERT INTO push_subscriptions(user_id,session_id,endpoint,subscription,renewal_hash,binding_id)
    VALUES($1,$2,$3,$4,$5,COALESCE($6::uuid,gen_random_uuid())) ON CONFLICT(endpoint) DO UPDATE SET user_id=$1,session_id=$2,subscription=$4,renewal_hash=$5,
    binding_id=CASE WHEN push_subscriptions.user_id=$1 AND push_subscriptions.session_id=$2 THEN push_subscriptions.binding_id ELSE gen_random_uuid() END,updated_at=NOW()
    RETURNING id,binding_id`,
    [userId, sessionId, sub.endpoint, sub, digest(renewal), bindingId || null],
  );
  return {
    subscriptionId: result.rows[0].id,
    bindingId: result.rows[0].binding_id,
    renewalToken: renewal,
    publicKey: env.push.publicKey,
    sessionExpiresAt: session.rows[0].expires_at,
  };
}
async function register(userId, sessionId, value) {
  if (!configured())
    throw new ApiError(503, "Background notifications are not configured");
  const sub = validateSubscription(value);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await upsert(db, userId, sessionId, sub);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
async function renew(token, value) {
  if (!configured())
    throw new ApiError(503, "Background notifications are not configured");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new ApiError(401, "Push renewal expired");
  const sub = validateSubscription(value);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const old = (
      await db.query(
        "SELECT * FROM push_subscriptions WHERE renewal_hash=$1 FOR UPDATE",
        [digest(token)],
      )
    ).rows[0];
    if (!old) throw new ApiError(401, "Push renewal expired");
    const next = await upsert(
      db,
      old.user_id,
      old.session_id,
      sub,
      old.binding_id,
    );
    if (old.id !== next.subscriptionId) {
      await db.query(
        `INSERT INTO push_jobs(notification_id,subscription_id,binding_id,expires_at)
        SELECT notification_id,$2,$3,expires_at FROM push_jobs WHERE subscription_id=$1 AND completed_at IS NULL
        ON CONFLICT(notification_id,subscription_id) DO NOTHING`,
        [old.id, next.subscriptionId, next.bindingId],
      );
      await db.query("DELETE FROM push_subscriptions WHERE id=$1", [old.id]);
    }
    await db.query("COMMIT");
    return next;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
async function remove(userId, endpoint) {
  await pool.query(
    "DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2",
    [userId, endpoint],
  );
}

async function issueNotificationActionToken({ notificationId, messageId, userId, sessionId, subscriptionId, bindingId }) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO notification_action_tokens
       (token_hash,notification_id,message_id,user_id,session_id,subscription_id,binding_id,action,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'mark_read',NOW()+INTERVAL '10 minutes')`,
    [digest(token), notificationId, messageId, userId, sessionId, subscriptionId, bindingId],
  );
  return token;
}

async function markNotificationReadAction(token, io) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new ApiError(404, "Notification action is no longer available");
  const db = await pool.connect();
  let action;
  try {
    await db.query("BEGIN");
    action = (await db.query(
      `SELECT a.notification_id,a.message_id,a.user_id,a.session_id,m.room_id,m.room_sequence
       FROM notification_action_tokens a
       JOIN notifications n ON n.id=a.notification_id AND n.recipient_id=a.user_id
       JOIN messages m ON m.id=a.message_id AND m.id=n.reference_id
       JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=a.user_id
       JOIN push_subscriptions p ON p.id=a.subscription_id AND p.user_id=a.user_id AND p.binding_id=a.binding_id
       JOIN auth_sessions s ON s.id=a.session_id AND s.user_id=a.user_id
       JOIN users u ON u.id=a.user_id
       WHERE a.token_hash=$1 AND a.action='mark_read' AND a.used_at IS NULL
         AND a.expires_at>NOW() AND n.seen=FALSE AND m.deleted_at IS NULL
         AND s.revoked_at IS NULL AND s.expires_at>NOW()
         AND u.deleted_at IS NULL AND u.suspended_at IS NULL
         AND message_visible(m.id,a.user_id) AND ${policy.visibleSql("n")}
       FOR UPDATE OF a`,
      [digest(token)],
    )).rows[0];
    if (!action) throw new ApiError(404, "Notification action is no longer available");

    // The receipt service repeats the room membership check and advances the
    // read pointer only through the specific message represented by this push.
    // Acknowledging the receipt also marks the corresponding visible
    // notifications as seen in the same receipt transaction. Keep that as the
    // single source of truth instead of trying to update the now-seen rows a
    // second time below.
    const receipt = await require("./messageReceipt.service").acknowledge({
      roomId: action.room_id,
      userId: action.user_id,
      messageId: action.message_id,
      through: true,
      read: true,
      io,
    });
    if (!receipt.notificationsUpdated)
      throw new ApiError(404, "Notification action is no longer available");
    await db.query("UPDATE notification_action_tokens SET used_at=NOW() WHERE token_hash=$1", [digest(token)]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
  return { markedRead: true };
}

async function dispatch(limit = 50, transport = webpush.sendNotification) {
  if (!configured()) return 0;
  const token = crypto.randomUUID();
  const jobs = await pool.query(
    `UPDATE push_jobs SET attempts=attempts+1,lease_until=NOW()+INTERVAL '60 seconds',lease_token=$2
    WHERE id IN (SELECT id FROM push_jobs WHERE completed_at IS NULL AND next_attempt_at<=NOW()
    AND (lease_until IS NULL OR lease_until<NOW()) ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`,
    [limit, token],
  );
  for (const job of jobs.rows) {
    try {
      if (
        !(
          await pool.query(
            "UPDATE push_jobs SET lease_until=NOW()+INTERVAL '60 seconds' WHERE id=$1 AND lease_token=$2 RETURNING id",
            [job.id, token],
          )
        ).rowCount
      )
        continue;
      const sub = await pool.query(
        `SELECT p.*,s.expires_at FROM push_subscriptions p JOIN auth_sessions s ON s.id=p.session_id
        JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND p.binding_id=$2 AND s.revoked_at IS NULL AND s.expires_at>NOW() AND u.deleted_at IS NULL`,
        [job.subscription_id, job.binding_id],
      );
      const checked = await policy.interruption(job.notification_id);
      let outcome = "suppressed";
      if (
        sub.rows.length &&
        checked.allowed &&
        sub.rows[0].user_id === checked.notification.recipient_id &&
        new Date(job.expires_at) > new Date()
      ) {
        const payload = buildPayload(checked.notification, checked.unseenCount || 0);
        let markReadToken = null;
        if (["mention", "new_message", "file_uploaded", "reminder"].includes(checked.notification.type)) {
          markReadToken = await issueNotificationActionToken({
            notificationId: job.notification_id,
            messageId: checked.notification.reference_id,
            userId: sub.rows[0].user_id,
            sessionId: sub.rows[0].session_id,
            subscriptionId: sub.rows[0].id,
            bindingId: job.binding_id,
          });
        }
        await transport(
          sub.rows[0].subscription,
          JSON.stringify({
            id: job.notification_id,
            bindingId: job.binding_id,
            roomId: checked.notification.room_id,
            title: payload.title,
            body: payload.body,
            tag: payload.tag,
            url: "/notifications",
            actionToken: markReadToken,
          }),
          {
            vapidDetails: {
              subject: env.push.subject,
              publicKey: env.push.publicKey,
              privateKey: env.push.privateKey,
            },
            TTL: 300,
            timeout: 10000,
            urgency: "normal",
          },
        );
        outcome = "accepted";
      }
      await pool.query(
        "UPDATE push_jobs SET completed_at=NOW(),outcome=$3,lease_until=NULL WHERE id=$1 AND lease_token=$2",
        [job.id, token, outcome],
      );
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) {
        await pool.query("DELETE FROM push_subscriptions WHERE id=$1", [
          job.subscription_id,
        ]);
      } else if (
        job.attempts >= 8 ||
        new Date(job.expires_at) <= new Date() ||
        (error.statusCode >= 400 &&
          error.statusCode < 500 &&
          error.statusCode !== 429)
      ) {
        await pool.query(
          "UPDATE push_jobs SET completed_at=NOW(),outcome='failed',lease_until=NULL WHERE id=$1 AND lease_token=$2",
          [job.id, token],
        );
      } else {
        const header = error.headers?.["retry-after"];
        const retry =
          Number(header) ||
          Math.max(0, (Date.parse(header) - Date.now()) / 1000) ||
          0;
        const seconds = Math.min(
          900,
          Math.max(retry, Math.min(300, 5 * 2 ** job.attempts)),
        );
        await pool.query(
          "UPDATE push_jobs SET lease_until=NULL,next_attempt_at=NOW()+($3::int*INTERVAL '1 second') WHERE id=$1 AND lease_token=$2",
          [job.id, token, Math.ceil(seconds)],
        );
      }
    }
  }
  return jobs.rowCount;
}

async function sendCallInvitation(userId, call) {
  if (!configured()) return 0;
  if (await require("./presence.service").isUserOnline(userId)) return 0;
  const subscriptions = await pool.query(
    `SELECT p.id,p.subscription,p.binding_id,s.expires_at,
      COALESCE(np.push_enabled,TRUE) AS push_enabled,
      COALESCE(np.activity_level,'all') AS activity_level,COALESCE(np.muted,'{}'::jsonb) AS muted,
      np.quiet_hours,np.quiet_hours_timezone,u.dnd_until,
      rmp.muted AS room_muted,rmp.mute_until
     FROM push_subscriptions p JOIN auth_sessions s ON s.id=p.session_id
     JOIN users u ON u.id=p.user_id
     LEFT JOIN notification_preferences np ON np.user_id=u.id
     LEFT JOIN room_member_preferences rmp ON rmp.room_id=$2 AND rmp.user_id=u.id
     WHERE p.user_id=$1 AND s.revoked_at IS NULL AND s.expires_at>NOW()
       AND u.deleted_at IS NULL AND u.suspended_at IS NULL`,
    [userId, call.roomId],
  );
  let sent = 0;
  for (const subscription of subscriptions.rows) {
    const dnd = subscription.dnd_until && new Date(subscription.dnd_until) > new Date();
    const roomMute = subscription.room_muted || (subscription.mute_until && new Date(subscription.mute_until) > new Date());
    const quiet = isQuietNow(subscription.quiet_hours || [], subscription.quiet_hours_timezone || "UTC");
    if (!subscription.push_enabled || subscription.activity_level === "none" || dnd || roomMute || quiet)
      continue;
    try {
      await webpush.sendNotification(
        subscription.subscription,
        JSON.stringify({
          id: call.id,
          bindingId: subscription.binding_id,
          kind: "call",
          callId: call.id,
          roomId: call.roomId,
          title: "Conclave",
          body: call.callType === "video" ? "Incoming video call" : "Incoming voice call",
        }),
        {
          vapidDetails: { subject: env.push.subject, publicKey: env.push.publicKey, privateKey: env.push.privateKey },
          TTL: CALL_PUSH_TTL_SECONDS,
          timeout: 5000,
          urgency: "high",
        },
      );
      sent++;
    } catch (error) {
      if ([404, 410].includes(error.statusCode))
        await pool.query("DELETE FROM push_subscriptions WHERE id=$1", [subscription.id]);
      else console.warn("Call push could not be delivered", error.statusCode || error.message);
    }
  }
  return sent;
}
async function prune() {
  await pool.query(
    "DELETE FROM notification_action_tokens WHERE used_at IS NOT NULL OR expires_at<NOW()",
  );
  await pool.query(
    "DELETE FROM push_jobs WHERE completed_at<NOW()-INTERVAL '30 days'",
  );
  await pool.query(
    "DELETE FROM push_subscriptions p USING auth_sessions s WHERE p.session_id=s.id AND (s.revoked_at IS NOT NULL OR s.expires_at<NOW())",
  );
}
let timer;
let work = Promise.resolve();
function start() {
  if (timer) return;
  let pruned = 0;
  const run = () => {
    work = work
      .then(async () => {
        await dispatch();
        if (Date.now() - pruned > 3600000) {
          await prune();
          pruned = Date.now();
        }
      })
      .catch((e) => console.error("Push worker deferred", e.message));
  };
  timer = setInterval(run, 3000);
  timer.unref();
  run();
}
async function stop() {
  clearInterval(timer);
  timer = null;
  await work;
}
module.exports = {
  configured,
  validateSubscription,
  register,
  renew,
  remove,
  issueNotificationActionToken,
  markNotificationReadAction,
  sendCallInvitation,
  dispatch,
  start,
  stop,
};
