import { api } from "./api";
import { getSessionUserId } from "./session";
import { isDevAuthBypass } from "../config/devPreview";
let protocol;
async function loadProtocol() {
  protocol ||= await import("./cryptoProtocol");
  await protocol.ready;
}
let vault = null;
let starting = null;
let generation = 0;
const request = async (method, path, data) =>
  (await api({ method, url: `/encryption${path}`, data })).data.data;
function storage(userId, value, write = false) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("conclave-encryption", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("vaults");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result,
        tx = db.transaction("vaults", write ? "readwrite" : "readonly"),
        op = write
          ? tx.objectStore("vaults").put(value, userId)
          : tx.objectStore("vaults").get(userId);
      tx.oncomplete = () => {
        db.close();
        resolve(write ? value : op.result);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
function checkAccount(userId) {
  if (getSessionUserId() !== userId)
    throw new Error("Account changed. Reopen this conversation.");
}
function withKeyLock(userId, kind, work) {
  if (!navigator.locks)
    throw new Error(
      "Secure device setup requires Web Locks support in this browser.",
    );
  return navigator.locks.request(`conclave-keys:${userId}:${kind}`, work);
}
async function persistValue(value, { replaceRoot = false, trustUserId } = {}) {
  const version = generation;
  return withKeyLock(value.userId, "save", async () => {
    checkAccount(value.userId);
    const old = await storage(value.userId);
    if (version !== generation) throw new Error("Encryption was locked.");
    let next = value;
    if (old && !replaceRoot) {
      if (
        old.identityKey &&
        value.identityKey &&
        old.identityKey !== value.identityKey
      )
        throw new Error(
          "Encryption identity changed. Reopen this device before continuing.",
        );
      const identities = { ...old.identities, ...value.identities };
      for (const [id, key] of Object.entries(old.identities || {})) {
        if (
          id !== trustUserId &&
          value.identities?.[id] &&
          value.identities[id] !== key
        )
          throw new Error(
            "A participant’s encryption identity changed. Verify its safety code first.",
          );
      }
      const devices = new Map(
        [
          ...old.previousDevices,
          old.device,
          ...value.previousDevices,
          value.device,
        ].map((d) => [d.id, d]),
      );
      next = {
        ...value,
        identities,
        verified: { ...old.verified, ...value.verified },
        previousDevices: [...devices.values()].filter(
          (d) => d.id !== value.device.id,
        ),
      };
    }
    checkAccount(value.userId);
    await storage(value.userId, next, true);
    return next;
  });
}
async function save(options) {
  if (vault) {
    const next = await persistValue(vault, options);
    vault = next;
  }
}
export function lockEncryption() {
  generation++;
  vault = null;
  starting = null;
}
export async function forgetLocalEncryption(userId) {
  lockEncryption();
  const req = indexedDB.open("conclave-encryption", 1);
  await new Promise((resolve, reject) => {
    req.onupgradeneeded = () => req.result.createObjectStore("vaults");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result,
        tx = db.transaction("vaults", "readwrite");
      tx.objectStore("vaults").delete(userId);
      tx.objectStore("vaults").delete(`pending-reset:${userId}`);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
export async function initializeEncryption() {
  if (isDevAuthBypass) return null;
  const userId = getSessionUserId();
  if (!userId) return null;
  if (vault?.userId === userId) return vault;
  if (starting) return starting;
  const version = generation;
  const setup = async () => {
    await loadProtocol();
    let value = await storage(userId);
    let state;
    try {
      state = await request("get", "/devices");
    } catch (error) {
      if (
        value?.identitySecret &&
        (!error.response || error.response.status >= 500)
      ) {
        checkAccount(userId);
        if (version !== generation) throw error;
        vault = value;
        return value;
      }
      throw error;
    }
    checkAccount(userId);
    const pendingReset = await storage(`pending-reset:${userId}`);
    if (pendingReset?.identityKey === state.identityKey) value = pendingReset;
    if (!value) value = protocol.createVault(userId, !state.identityKey);
    if (
      value.identityKey &&
      state.identityKey &&
      value.identityKey !== state.identityKey
    )
      throw new Error(
        "Your account encryption identity changed. Restore its backup before sending.",
      );
    if (
      state.devices.some(
        (d) =>
          d.id === value.device.id &&
          (d.revoked_at ||
            (!d.approved_at && new Date(d.expires_at) < new Date())),
      )
    )
      value = protocol.rotateDevice(value);
    // A successful registration response can be lost. Persist private material
    // before publishing its public identity, so retries retain the same keys.
    if (version !== generation)
      throw new Error("Encryption setup was cancelled.");
    checkAccount(userId);
    value = await persistValue(value);
    if (version !== generation)
      throw new Error("Encryption setup was cancelled.");
    checkAccount(userId);
    const result = await request(
      "post",
      "/devices",
      protocol.publicDevice(
        value,
        navigator.userAgentData?.platform || navigator.platform || "Browser",
      ),
    );
    if (!value.identitySecret && result.approved_at) {
      const link = await request("get", `/devices/${value.device.id}/link`);
      if (link.link_payload) {
        value = protocol.openLink(value, link.link_payload);
        if (value.identityKey !== result.identityKey)
          throw new Error("The linked identity does not match this account.");
      }
    }
    if (version !== generation)
      throw new Error("Encryption setup was cancelled.");
    checkAccount(userId);
    vault = value;
    await save();
    return vault;
  };
  const work = withKeyLock(userId, "lifecycle", setup).finally(() => {
    if (starting === work) starting = null;
  });
  starting = work;
  return work;
}
export async function encryptionStatus() {
  const value = await initializeEncryption();
  const state = await request("get", "/devices");
  checkAccount(value?.userId);
  return {
    ...state,
    userId: value.userId,
    ready: Boolean(value?.identitySecret),
    deviceId: value?.device.id,
    deviceFingerprint: value ? protocol.deviceFingerprint(value.device) : "",
    fingerprint: state.identityKey
      ? protocol.fingerprint(state.identityKey)
      : "",
    identities: value?.identities || {},
    verified: value?.verified || {},
  };
}
export async function refreshEncryption() {
  vault = null;
  return initializeEncryption();
}
export async function prepareEncryptedMedia(item) {
  if (isDevAuthBypass || item.media?.encrypted) return item;
  const room = (await api.get(`/rooms/${item.roomId}`)).data.data;
  if (room.encryption_mode !== "e2ee-v1") return item;
  await initializeEncryption();
  if (!vault?.identitySecret)
    throw new Error(
      "Link this device or restore its encryption backup in Settings.",
    );
  const file = await protocol.sealFile(
    item.media.blob,
    item.roomId,
    item.clientId,
  );
  return {
    ...item,
    media: {
      ...item.media,
      encrypted: true,
      uploadBlob: file.blob,
      crypto: file.crypto,
    },
  };
}
export async function encryptOutgoing(payload, media, revision = 0) {
  if (isDevAuthBypass) return payload;
  const room = (await api.get(`/rooms/${payload.roomId}`)).data.data;
  if (room.encryption_mode !== "e2ee-v1") return payload;
  const value = await initializeEncryption();
  checkAccount(value?.userId);
  if (payload.forwardSource)
    throw new Error(
      "Forwarding encrypted content requires an explicit decrypted export. This action is unavailable.",
    );
  const roster = await request("get", `/rooms/${payload.roomId}`);
  const file = media
    ? {
        url: payload.attachments?.[0]?.url,
        crypto: media.crypto,
        metadata: {
          filename: media.filename,
          mime_type: media.blob.type,
          size: media.blob.size,
          ...media.metadata,
        },
      }
    : undefined;
  if (media && !media.encrypted)
    throw new Error(
      "This attachment was not encrypted. Cancel it and attach it again.",
    );
  const encryptedPayload = protocol.sealMessage(value, roster, payload, {
    file,
    revision,
  });
  vault = await persistValue(value);
  return {
    ...payload,
    content: undefined,
    mentionedUserIds: [],
    encryptedPayload,
  };
}
export async function decryptMessage(message) {
  if (!message?.encrypted_payload || message.is_deleted || message.deleted_at)
    return message;
  try {
    const value = await initializeEncryption();
    checkAccount(value?.userId);
    const result = protocol.openMessage(value, message);
    vault = await persistValue(value);
    return result;
  } catch (error) {
    return {
      ...message,
      content: "Encrypted message",
      attachments: [],
      _cryptoError: error.message,
      _decrypted: false,
    };
  }
}
export async function decryptMessages(messages) {
  return Promise.all(messages.map(decryptMessage));
}
export async function encryptEdit(message, content) {
  const value = await initializeEncryption();
  if (!message._decrypted)
    throw new Error("Unlock this message before editing it.");
  const attachment = message.attachments?.[0];
  const file = attachment
    ? {
        url: attachment.url,
        crypto: attachment.crypto,
        metadata: {
          filename: attachment.filename,
          mime_type: attachment.mime_type,
          size: attachment.size,
          width: attachment.width,
          height: attachment.height,
          preview_url: attachment.preview_url,
          duration: attachment.duration,
        },
      }
    : undefined;
  const roster = await request("get", `/rooms/${message.room_id}`);
  const payload = protocol.sealMessage(
    value,
    roster,
    {
      roomId: message.room_id,
      clientId: message.client_id,
      content,
      ...(message.thread_root_id
        ? { threadRootId: message.thread_root_id }
        : {}),
    },
    { file, revision: message.encrypted_payload.revision + 1 },
  );
  vault = await persistValue(value);
  return payload;
}
export async function createEncryptionBackup() {
  const value = await initializeEncryption();
  if (!value?.identitySecret)
    throw new Error("Link or restore this device first.");
  await save();
  const backup = protocol.sealBackup(vault);
  await request("put", "/backup", backup.payload);
  return backup.recoveryKey;
}
export async function restoreEncryptionBackup(key) {
  await loadProtocol();
  const userId = getSessionUserId();
  const backup = await request("get", "/backup");
  let value = protocol.openBackup(userId, backup.payload, key.trim());
  const state = await request("get", "/devices");
  if (value.identityKey !== state.identityKey)
    throw new Error("The backup identity does not match this account.");
  value = protocol.rotateDevice(value);
  await request(
    "post",
    "/devices",
    protocol.publicDevice(value, "Recovered browser"),
  );
  checkAccount(userId);
  vault = value;
  await save();
  window.dispatchEvent(new Event("conclave:keys-ready"));
}
export async function approveEncryptionDevice(device, code) {
  const value = await initializeEncryption();
  if (!value?.identitySecret)
    throw new Error("An approved device is required.");
  if (code.trim().toLowerCase() !== protocol.deviceFingerprint(device))
    throw new Error(
      "Device safety code does not match. Compare it on the new device.",
    );
  await request(
    "post",
    `/devices/${device.id}/approve`,
    protocol.sealLink(value, device),
  );
}
export async function resetEncryptionIdentity(password) {
  await loadProtocol();
  const userId = getSessionUserId();
  checkAccount(userId);
  const replacement = protocol.createVault(userId);
  // Retain the new secret durably before an irreversible server response can
  // be lost. Startup adopts it only if the committed server identity matches.
  await storage(`pending-reset:${userId}`, replacement, true);
  await request("post", "/reset", {
    password,
    confirmation: "RESET ENCRYPTION",
    device: protocol.publicDevice(replacement, "Reset browser"),
  });
  checkAccount(userId);
  vault = replacement;
  await save({ replaceRoot: true });
  await storage(`pending-reset:${userId}`, null, true);
  window.dispatchEvent(new Event("conclave:keys-ready"));
}
export async function trustEncryptionIdentity(userId, identityKey, code) {
  await initializeEncryption();
  if (code.trim().toLowerCase() !== protocol.fingerprint(identityKey))
    throw new Error("Safety code does not match.");
  vault.identities[userId] = identityKey;
  vault.verified[userId] = identityKey;
  await save({ trustUserId: userId });
  window.dispatchEvent(new Event("conclave:keys-ready"));
}
export const identityFingerprint = async (key) => {
  await loadProtocol();
  return protocol.fingerprint(key);
};
export async function encryptedConversationDevices(roomId) {
  return request("get", `/rooms/${roomId}`);
}
