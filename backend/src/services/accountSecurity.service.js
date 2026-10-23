const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const { Resend } = require("resend");
const { pool, query } = require("../config/db");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");
const { revokeSessionAccess } = require("./realtimeAccess.service");

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const mailConfigured = () =>
  Boolean(
    env.mail.apiKey &&
    env.mail.from &&
    Buffer.from(env.mail.encryptionKey || "", "base64url").length === 32,
  );
function encryptMail(message) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv(
      "aes-256-gcm",
      Buffer.from(env.mail.encryptionKey, "base64url"),
      iv,
    );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(message), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}
function decryptMail(value) {
  const cipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(env.mail.encryptionKey, "base64url"),
    Buffer.from(value.iv, "base64url"),
  );
  cipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(value.ciphertext, "base64url")),
      cipher.final(),
    ]).toString("utf8"),
  );
}
function password(value) {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    Buffer.byteLength(value) > 72
  )
    throw new ApiError(
      400,
      "Use a password of at least 12 characters and at most 72 bytes",
    );
  return value;
}
async function confirm(userId, value, db = { query }) {
  if (
    !(await require("../middlewares/rateLimit.middleware").consumeShared(
      `account-password:${userId}`,
      { max: 10, windowMs: 15 * 60 * 1000 },
    ))
  )
    throw new ApiError(
      429,
      "Too many password confirmations. Try again later.",
    );
  const user = (
    await db.query(
      "SELECT password_hash FROM users WHERE id=$1 AND deleted_at IS NULL",
      [userId],
    )
  ).rows[0];
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > 72 ||
    !user ||
    !(await bcrypt.compare(value, user.password_hash))
  )
    throw new ApiError(403, "Current password is incorrect");
}
async function sendToken(user, purpose, send) {
  const token = crypto.randomBytes(32).toString("base64url");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [
      user.id,
    ]);
    await db.query(
      "UPDATE account_tokens SET consumed_at=NOW() WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL",
      [user.id, purpose],
    );
    const row = await db.query(
      "INSERT INTO account_tokens(user_id,purpose,token_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '30 minutes') RETURNING id",
      [user.id, purpose, hash(token)],
    );
    const path = purpose === "verify_email" ? "verify" : "recovery";
    const url = new URL(`/account/${path}`, env.mail.frontendUrl);
    url.hash = `token=${token}`;
    const message = {
      from: env.mail.from,
      to: user.email,
      subject:
        purpose === "verify_email"
          ? "Verify your Conclave email"
          : "Reset your Conclave password",
      text: `${purpose === "verify_email" ? "Verify your email address" : "Reset your password"} using this link within 30 minutes:\n\n${url.href}\n\nIf you did not request this, ignore this email. Conclave cannot recover encrypted history without your separate encryption recovery key.`,
    };
    if (send) await send(message);
    else
      await db.query(
        "INSERT INTO account_mail_jobs(token_id,encrypted_payload) VALUES($1,$2)",
        [row.rows[0].id, encryptMail(message)],
      );
    await db.query("COMMIT");
    return row.rows[0].id;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
async function requestToken(email, purpose, { userId, send } = {}) {
  if (!send && !mailConfigured())
    throw new ApiError(503, "Account email delivery is not configured");
  const normalized =
    typeof email === "string" ? email.trim().toLowerCase() : "";
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    throw new ApiError(400, "Enter a valid email address");
  const row = (
    await query(
      `SELECT id,email,email_verified_at FROM users WHERE lower(email)=$1 AND deleted_at IS NULL ${userId ? "AND id=$2" : ""}`,
      [normalized, ...(userId ? [userId] : [])],
    )
  ).rows[0];
  if (row && !(purpose === "verify_email" && row.email_verified_at)) {
    try {
      await sendToken(row, purpose, send);
    } catch (error) {
      console.error("Account email delivery failed", {
        code: error.code || "MAIL_FAILED",
      });
    }
  }
  return {
    message: "If the account is eligible, an email will arrive shortly.",
  };
}
async function redeem(token, purpose, newPassword, io) {
  if (typeof token !== "string" || !/^[\w-]{43}$/.test(token))
    throw new ApiError(400, "This link is invalid or expired");
  const passwordHash =
    purpose === "reset_password"
      ? await bcrypt.hash(password(newPassword), 12)
      : null;
  const db = await pool.connect();
  let sessions = [];
  try {
    await db.query("BEGIN");
    // Lock the account before tokens, matching issuance and password changes.
    const candidate = (
      await db.query(
        "SELECT user_id FROM account_tokens WHERE token_hash=$1 AND purpose=$2",
        [hash(token), purpose],
      )
    ).rows[0];
    if (!candidate) throw new ApiError(400, "This link is invalid or expired");
    await db.query(
      "SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE",
      [candidate.user_id],
    );
    const row = (
      await db.query(
        `UPDATE account_tokens SET consumed_at=NOW() WHERE token_hash=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at>NOW()
      AND EXISTS(SELECT 1 FROM users WHERE id=user_id AND deleted_at IS NULL) RETURNING user_id`,
        [hash(token), purpose],
      )
    ).rows[0];
    if (!row) throw new ApiError(400, "This link is invalid or expired");
    if (purpose === "verify_email")
      await db.query(
        "UPDATE users SET email_verified_at=COALESCE(email_verified_at,NOW()) WHERE id=$1",
        [row.user_id],
      );
    else {
      await db.query(
        "UPDATE users SET password_hash=$2,email_verified_at=COALESCE(email_verified_at,NOW()) WHERE id=$1",
        [row.user_id, passwordHash],
      );
      sessions = (
        await db.query(
          "UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1 RETURNING id",
          [row.user_id],
        )
      ).rows;
      await db.query(
        "UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1",
        [row.user_id],
      );
      await db.query(
        "UPDATE account_tokens SET consumed_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL",
        [row.user_id],
      );
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  for (const session of sessions) await revokeSessionAccess(io, session.id);
  return {
    message:
      purpose === "verify_email"
        ? "Email verified"
        : "Password reset. Sign in again on your devices.",
  };
}
async function listSessions(userId, currentId) {
  return (
    await query(
      `SELECT id,device_label,user_agent,created_at,last_active_at,expires_at,(id=$2) AS current
    FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 100`,
      [userId, currentId],
    )
  ).rows;
}
async function revoke(userId, currentId, target, value, io) {
  await confirm(userId, value);
  const db = await pool.connect();
  let sessions;
  try {
    await db.query("BEGIN");
    sessions = (
      await db.query(
        `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1 AND ${target === "others" ? "id<>$2" : "id=$2"} RETURNING id`,
        [userId, target === "others" ? currentId : target],
      )
    ).rows;
    if (target !== "others" && !sessions.length)
      throw new ApiError(404, "Session not found");
    await db.query(
      "UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,NOW()) WHERE session_id=ANY($1::uuid[])",
      [sessions.map((s) => s.id)],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  for (const session of sessions) await revokeSessionAccess(io, session.id);
  return { revoked: sessions.length };
}
async function dispatchMail(limit = 10, send) {
  if (!mailConfigured()) return 0;
  const token = crypto.randomUUID();
  const jobs = await query(
    `UPDATE account_mail_jobs SET lease_until=NOW()+INTERVAL '60 seconds',lease_token=$2,attempts=attempts+1
    WHERE id IN(SELECT id FROM account_mail_jobs WHERE completed_at IS NULL AND next_attempt_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`,
    [limit, token],
  );
  for (const job of jobs.rows) {
    try {
      if (
        !(
          await query(
            "UPDATE account_mail_jobs SET lease_until=NOW()+INTERVAL '60 seconds' WHERE id=$1 AND lease_token=$2 RETURNING id",
            [job.id, token],
          )
        ).rowCount
      )
        continue;
      const valid = (
        await query(
          "SELECT 1 FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND t.consumed_at IS NULL AND t.expires_at>NOW() AND u.deleted_at IS NULL",
          [job.token_id],
        )
      ).rowCount;
      let outcome = "expired";
      if (valid && new Date(job.expires_at) > new Date()) {
        const transport = send || sendWithResend;
        await transport(decryptMail(job.encrypted_payload), {
          idempotencyKey: `account-mail/${job.id}`,
        });
        outcome = "accepted";
      }
      await query(
        "UPDATE account_mail_jobs SET completed_at=NOW(),outcome=$3,encrypted_payload=$4,lease_until=NULL WHERE id=$1 AND lease_token=$2",
        [job.id, token, outcome, {}],
      );
    } catch (error) {
      if (job.attempts >= 8 || new Date(job.expires_at) <= new Date())
        await query(
          "UPDATE account_mail_jobs SET completed_at=NOW(),outcome='failed',encrypted_payload='{}',lease_until=NULL WHERE id=$1 AND lease_token=$2",
          [job.id, token],
        );
      else
        await query(
          "UPDATE account_mail_jobs SET lease_until=NULL,next_attempt_at=NOW()+($3::int*INTERVAL '1 second') WHERE id=$1 AND lease_token=$2",
          [job.id, token, Math.min(300, 5 * 2 ** job.attempts)],
        );
      console.error("Account email delivery deferred", {
        code: error.code || "MAIL_FAILED",
      });
    }
  }
  return jobs.rowCount;
}
async function sendWithResend(mail, { idempotencyKey }) {
  const { data, error } = await new Resend(env.mail.apiKey).emails.send(mail, {
    idempotencyKey,
    signal: AbortSignal.timeout(15000),
  });
  // The SDK returns API errors rather than throwing them. Never mark a
  // rejected or incomplete response as an accepted email job.
  if (error || !data?.id) {
    const failure = new Error("Email provider did not accept the message");
    failure.code = error?.name || "RESEND_INVALID_RESPONSE";
    throw failure;
  }
}
let timer,
  work = Promise.resolve(),
  prunedAt = 0;
function start() {
  if (timer) return;
  const run = () => {
    work = work
      .then(async () => {
        await dispatchMail();
        if (Date.now() - prunedAt > 3600000) {
          await query(
            "DELETE FROM account_tokens WHERE expires_at<NOW()-INTERVAL '1 day'",
          );
          prunedAt = Date.now();
        }
      })
      .catch((error) =>
        console.error("Account email worker deferred", {
          code: error.code || "MAIL_FAILED",
        }),
      );
  };
  timer = setInterval(run, 5000);
  timer.unref();
  run();
}
async function stop() {
  clearInterval(timer);
  timer = null;
  await work;
}
module.exports = {
  password,
  confirm,
  mailConfigured,
  requestToken,
  redeem,
  listSessions,
  revoke,
  dispatchMail,
  start,
  stop,
};
