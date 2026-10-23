const sodium = require("libsodium-wrappers");
const { query, pool } = require("../config/db");
const ApiError = require("../utils/ApiError");
const { UUID } = require("../utils/mediaPagination");
const privacy = require("./privacy.service");
const scheme = "conclave-e2ee-v1";
const b64 = (value) =>
  sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
function bytes(value, size) {
  try {
    return typeof value === "string" && b64(value).length === size;
  } catch {
    return false;
  }
}
const certificate = (userId, device) => ({
  scheme,
  userId,
  deviceId: device.id,
  boxKey: device.box_key,
  signingKey: device.signing_key,
});
function verifyCertificate(root, device) {
  try {
    return sodium.crypto_sign_verify_detached(
      b64(device.certificate_signature),
      JSON.stringify(certificate(device.user_id, device)),
      b64(root),
    );
  } catch {
    return false;
  }
}
function validateDevice(value) {
  if (
    !UUID.test(value?.id || "") ||
    !bytes(value.boxKey, 32) ||
    !bytes(value.signingKey, 32) ||
    typeof value.label !== "string" ||
    !value.label.trim() ||
    value.label.length > 80
  )
    throw new ApiError(400, "Invalid encryption device");
}
async function state(userId) {
  return {
    identityKey: (
      await query("SELECT identity_public_key FROM users WHERE id=$1", [userId])
    ).rows[0].identity_public_key,
    devices: (
      await query(
        "SELECT id,label,box_key,signing_key,certificate,certificate_signature,approved_at,revoked_at,created_at,expires_at FROM encryption_devices WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
        [userId],
      )
    ).rows,
  };
}
async function register(userId, sessionId, value) {
  await sodium.ready;
  validateDevice(value);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const user = (
      await db.query(
        "SELECT identity_public_key FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [userId],
      )
    ).rows[0];
    if (!user) throw new ApiError(401, "Account unavailable");
    const row = {
      id: value.id,
      user_id: userId,
      box_key: value.boxKey,
      signing_key: value.signingKey,
      certificate_signature: value.signature,
    };
    let root = user.identity_public_key;
    if (!root) {
      if (
        !bytes(value.identityKey, 32) ||
        !verifyCertificate(value.identityKey, row)
      )
        throw new ApiError(400, "A signed account identity is required");
      root = value.identityKey;
      await db.query("UPDATE users SET identity_public_key=$2 WHERE id=$1", [
        userId,
        root,
      ]);
    }
    if (value.identityKey && value.identityKey !== root)
      throw new ApiError(
        409,
        "Your encryption identity changed. Restore or link an approved device.",
      );
    const approved = verifyCertificate(root, row);
    const current = (
      await db.query(
        "SELECT * FROM encryption_devices WHERE id=$1 FOR UPDATE",
        [value.id],
      )
    ).rows[0];
    if (
      current &&
      (current.user_id !== userId ||
        current.box_key !== value.boxKey ||
        current.signing_key !== value.signingKey ||
        current.revoked_at)
    )
      throw new ApiError(
        409,
        "Device is revoked or its identity does not match",
      );
    if (
      (
        await db.query(
          "SELECT COUNT(*)::int AS n FROM encryption_devices WHERE user_id=$1 AND revoked_at IS NULL AND (approved_at IS NOT NULL OR expires_at>NOW())",
          [userId],
        )
      ).rows[0].n >= 30 &&
      !current
    )
      throw new ApiError(409, "Remove an older encryption device first");
    const result = await db.query(
      `INSERT INTO encryption_devices(id,user_id,session_id,label,box_key,signing_key,certificate,certificate_signature,approved_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9 THEN NOW() ELSE NULL END)
      ON CONFLICT(id) DO UPDATE SET session_id=$3,label=$4,certificate=COALESCE(EXCLUDED.certificate,encryption_devices.certificate),
      certificate_signature=COALESCE(EXCLUDED.certificate_signature,encryption_devices.certificate_signature),approved_at=COALESCE(encryption_devices.approved_at,EXCLUDED.approved_at)
      RETURNING id,approved_at,link_payload`,
      [
        value.id,
        userId,
        sessionId,
        value.label,
        value.boxKey,
        value.signingKey,
        approved ? certificate(userId, row) : null,
        approved ? value.signature : null,
        approved,
      ],
    );
    await db.query("COMMIT");
    return { ...result.rows[0], identityKey: root };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
async function approve(userId, id, value) {
  await sodium.ready;
  if (
    !UUID.test(id) ||
    typeof value?.payload !== "string" ||
    value.payload.length > 700000 ||
    !bytes(value.signature, 64)
  )
    throw new ApiError(400, "Invalid device approval");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const root = (
      await db.query(
        "SELECT identity_public_key FROM users WHERE id=$1 FOR SHARE",
        [userId],
      )
    ).rows[0].identity_public_key;
    const device = (
      await db.query(
        "SELECT * FROM encryption_devices WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND approved_at IS NULL AND expires_at>NOW() FOR UPDATE",
        [id, userId],
      )
    ).rows[0];
    if (!device) throw new ApiError(404, "This device link request expired");
    device.certificate_signature = value.signature;
    if (!verifyCertificate(root, device))
      throw new ApiError(400, "Invalid approval signature");
    await db.query(
      "UPDATE encryption_devices SET certificate=$2,certificate_signature=$3,link_payload=$4,approved_at=NOW() WHERE id=$1",
      [id, certificate(userId, device), value.signature, value.payload],
    );
    await db.query("COMMIT");
    return { approved: true };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
async function takeLink(userId, sessionId, id) {
  if (!UUID.test(id)) throw new ApiError(400, "Invalid device");
  const row = (
    await query(
      "SELECT link_payload,certificate_signature FROM encryption_devices WHERE id=$1 AND user_id=$2 AND session_id=$3 AND approved_at IS NOT NULL AND revoked_at IS NULL",
      [id, userId, sessionId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "Device approval is not ready");
  return row;
}
async function roomDevices(db, roomId, userId) {
  if (
    !(
      await db.query(
        "SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2",
        [roomId, userId],
      )
    ).rowCount
  )
    throw new ApiError(403, "You are not a member of this conversation");
  const members = (
    await db.query(
      "SELECT u.id,u.identity_public_key FROM room_members rm JOIN users u ON u.id=rm.user_id WHERE rm.room_id=$1 ORDER BY u.id",
      [roomId],
    )
  ).rows;
  const devices = (
    await db.query(
      `SELECT d.id,d.user_id,d.box_key,d.signing_key,d.certificate,d.certificate_signature
    FROM encryption_devices d JOIN auth_sessions s ON s.id=d.session_id JOIN room_members rm ON rm.user_id=d.user_id AND rm.room_id=$1
    WHERE d.approved_at IS NOT NULL AND d.revoked_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>NOW() ORDER BY d.id`,
      [roomId],
    )
  ).rows;
  return { members, devices };
}
function signingBody(value) {
  return {
    scheme,
    roomId: value.roomId,
    clientId: value.clientId,
    senderId: value.senderId,
    deviceId: value.deviceId,
    revision: value.revision,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    keys: value.keys.map((k) => ({ deviceId: k.deviceId, key: k.key })),
  };
}
async function validateMessage(
  db,
  roomId,
  senderId,
  clientId,
  value,
  revision = 0,
) {
  await sodium.ready;
  if (
    !value ||
    value.scheme !== scheme ||
    value.roomId !== roomId ||
    value.senderId !== senderId ||
    value.clientId !== clientId ||
    value.revision !== revision ||
    !bytes(value.nonce, 24) ||
    !bytes(value.signature, 64) ||
    typeof value.ciphertext !== "string" ||
    value.ciphertext.length > 600000 ||
    !Array.isArray(value.keys) ||
    value.keys.length > 300
  )
    throw new ApiError(400, "Invalid encrypted message");
  const roster = await roomDevices(db, roomId, senderId);
  const sender = roster.devices.find(
    (d) => d.id === value.deviceId && d.user_id === senderId,
  );
  const roots = new Map(
    roster.members.map((u) => [u.id, u.identity_public_key]),
  );
  if (!sender || !verifyCertificate(roots.get(senderId), sender))
    throw new ApiError(403, "Approve this encryption device before sending");
  const ids = value.keys.map((k) => k.deviceId);
  if (
    new Set(ids).size !== ids.length ||
    roster.devices.length !== ids.length ||
    roster.devices.some((d) => !ids.includes(d.id)) ||
    roster.members.some((u) => !roster.devices.some((d) => d.user_id === u.id))
  )
    throw new ApiError(
      409,
      "Encryption recipients changed or a member needs an approved device. Retry after checking devices.",
    );
  if (value.keys.some((k) => !UUID.test(k.deviceId) || !bytes(k.key, 80)))
    throw new ApiError(400, "Invalid encrypted message keys");
  if (
    !sodium.crypto_sign_verify_detached(
      b64(value.signature),
      JSON.stringify(signingBody(value)),
      b64(sender.signing_key),
    )
  )
    throw new ApiError(400, "Encrypted message signature is invalid");
  return {
    ...signingBody(value),
    signature: value.signature,
    senderCertificate: sender.certificate,
    senderCertificateSignature: sender.certificate_signature,
    identityKey: roots.get(senderId),
  };
}
async function backup(userId, payload) {
  await sodium.ready;
  if (
    payload?.scheme !== scheme ||
    !bytes(payload.nonce, 24) ||
    typeof payload.ciphertext !== "string" ||
    payload.ciphertext.length > 900000
  )
    throw new ApiError(400, "Invalid encrypted backup");
  return (
    await query(
      `INSERT INTO encryption_backups(user_id,payload) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET payload=$2,revision=encryption_backups.revision+1,updated_at=NOW() RETURNING revision,updated_at`,
      [userId, payload],
    )
  ).rows[0];
}
async function reset(userId, sessionId, value, io) {
  await sodium.ready;
  if (value?.confirmation !== "RESET ENCRYPTION")
    throw new ApiError(400, "Confirm the irreversible encryption reset");
  await require("./accountSecurity.service").confirm(userId, value.password);
  validateDevice(value.device);
  const d = value.device,
    row = {
      id: d.id,
      user_id: userId,
      box_key: d.boxKey,
      signing_key: d.signingKey,
      certificate_signature: d.signature,
    };
  if (!bytes(d.identityKey, 32) || !verifyCertificate(d.identityKey, row))
    throw new ApiError(400, "Invalid replacement identity");
  const db = await pool.connect();
  let revoked = [];
  try {
    await db.query("BEGIN");
    await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    await db.query(
      "UPDATE encryption_devices SET revoked_at=COALESCE(revoked_at,NOW()),link_payload=NULL WHERE user_id=$1",
      [userId],
    );
    revoked = (
      await db.query(
        "UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1 AND id<>$2 RETURNING id",
        [userId, sessionId],
      )
    ).rows;
    await db.query(
      "UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,NOW()) WHERE session_id=ANY($1::uuid[])",
      [revoked.map((s) => s.id)],
    );
    await db.query("DELETE FROM encryption_backups WHERE user_id=$1", [userId]);
    await db.query("UPDATE users SET identity_public_key=$2 WHERE id=$1", [
      userId,
      d.identityKey,
    ]);
    await db.query(
      "INSERT INTO encryption_devices(id,user_id,session_id,label,box_key,signing_key,certificate,certificate_signature,approved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())",
      [
        d.id,
        userId,
        sessionId,
        d.label,
        d.boxKey,
        d.signingKey,
        certificate(userId, row),
        d.signature,
      ],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  for (const s of revoked)
    await require("./realtimeAccess.service").revokeSessionAccess(io, s.id);
  return { reset: true };
}
module.exports = {
  state,
  register,
  approve,
  takeLink,
  roomDevices,
  validateMessage,
  signingBody,
  backup,
  verifyCertificate,
  reset,
};
