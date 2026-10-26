import sodium from "libsodium-wrappers";

export const ready = sodium.ready;
export const SCHEME = "conclave-e2ee-v1";
export const ENCRYPTED_MIME = "application/vnd.conclave.encrypted";
const enc = (value) =>
  sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
const dec = (value) =>
  sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
const certificate = (userId, device) => ({
  scheme: SCHEME,
  userId,
  deviceId: device.id,
  boxKey: device.boxKey,
  signingKey: device.signingKey,
});
const newDevice = () => {
  const box = sodium.crypto_box_keypair(),
    sign = sodium.crypto_sign_keypair();
  return {
    id: crypto.randomUUID(),
    boxKey: enc(box.publicKey),
    boxSecret: enc(box.privateKey),
    signingKey: enc(sign.publicKey),
    signingSecret: enc(sign.privateKey),
  };
};
export function createVault(userId, root = true) {
  const identity = root ? sodium.crypto_sign_keypair() : null;
  return {
    version: 1,
    userId,
    identityKey: identity ? enc(identity.publicKey) : null,
    identitySecret: identity ? enc(identity.privateKey) : null,
    device: newDevice(),
    previousDevices: [],
    identities: {},
    verified: {},
  };
}
export function rotateDevice(vault) {
  return {
    ...vault,
    previousDevices: [...vault.previousDevices, vault.device],
    device: newDevice(),
  };
}
function validateVault(vault) {
  const validSigningPair = (secret, publicKey) => {
    const bytes = dec(secret);
    if (bytes.length !== sodium.crypto_sign_SECRETKEYBYTES) return false;
    const pair = sodium.crypto_sign_seed_keypair(bytes.subarray(0, 32));
    return enc(pair.publicKey) === publicKey && enc(pair.privateKey) === secret;
  };
  if (
    vault.version !== 1 ||
    !Array.isArray(vault.previousDevices) ||
    !vault.device ||
    !vault.identitySecret ||
    !validSigningPair(vault.identitySecret, vault.identityKey)
  )
    throw new Error("The recovered encryption identity is invalid.");
  for (const device of [vault.device, ...vault.previousDevices]) {
    if (
      dec(device.boxSecret).length !== 32 ||
      enc(sodium.crypto_scalarmult_base(dec(device.boxSecret))) !==
        device.boxKey ||
      !validSigningPair(device.signingSecret, device.signingKey)
    )
      throw new Error("A recovered device key is invalid.");
  }
  return vault;
}
export function publicDevice(vault, label = "Browser") {
  const cert = certificate(vault.userId, vault.device);
  return {
    id: vault.device.id,
    boxKey: vault.device.boxKey,
    signingKey: vault.device.signingKey,
    label,
    identityKey: vault.identityKey,
    ...(vault.identitySecret
      ? {
          signature: enc(
            sodium.crypto_sign_detached(
              JSON.stringify(cert),
              dec(vault.identitySecret),
            ),
          ),
        }
      : {}),
  };
}
export function fingerprint(identityKey) {
  return sodium
    .to_hex(sodium.crypto_generichash(32, dec(identityKey)))
    .match(/.{1,8}/g)
    .join(" ");
}
export function deviceFingerprint(device) {
  return sodium
    .to_hex(
      sodium.crypto_generichash(
        32,
        JSON.stringify({
          box: device.box_key || device.boxKey,
          sign: device.signing_key || device.signingKey,
        }),
      ),
    )
    .match(/.{1,8}/g)
    .join(" ");
}
function checkRoot(vault, userId, root) {
  if (!root) throw new Error("A participant has not set up encryption yet.");
  if (userId === vault.userId && root !== vault.identityKey)
    throw new Error(
      "Your account encryption identity changed. Restore or link the correct identity first.",
    );
  const known = vault.identities[userId];
  if (known && known !== root)
    throw new Error(
      "A participant’s encryption identity changed. Compare their safety code in Settings before trusting the new identity.",
    );
  vault.identities[userId] = root;
}
function checkDevice(device, root) {
  const cert = certificate(device.user_id, {
    id: device.id,
    boxKey: device.box_key,
    signingKey: device.signing_key,
  });
  if (
    !sodium.crypto_sign_verify_detached(
      dec(device.certificate_signature),
      JSON.stringify(cert),
      dec(root),
    )
  )
    throw new Error("A device certificate could not be verified.");
}
export function signingBody(value) {
  return {
    scheme: SCHEME,
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
export function sealMessage(
  vault,
  roster,
  payload,
  { file, revision = 0 } = {},
) {
  if (!vault.identitySecret)
    throw new Error(
      "Link this device or restore your encryption backup in Settings.",
    );
  for (const user of roster.members) {
    checkRoot(vault, user.id, user.identity_public_key);
    if (!roster.devices.some((d) => d.user_id === user.id))
      throw new Error(
        "A participant needs an approved encryption device before this message can be sent.",
      );
  }
  const roots = new Map(
    roster.members.map((u) => [u.id, u.identity_public_key]),
  );
  for (const device of roster.devices)
    checkDevice(device, roots.get(device.user_id));
  const key = sodium.randombytes_buf(32),
    nonce = sodium.randombytes_buf(24);
  const body = {
    content: payload.content || "",
    ...(payload.threadRootId ? { threadRootId: payload.threadRootId } : {}),
    ...(file ? { file } : {}),
    roomId: payload.roomId,
    clientId: payload.clientId,
    senderId: vault.userId,
  };
  const associated = JSON.stringify({
    scheme: SCHEME,
    roomId: payload.roomId,
    clientId: payload.clientId,
    senderId: vault.userId,
    revision,
  });
  const value = {
    scheme: SCHEME,
    roomId: payload.roomId,
    clientId: payload.clientId,
    senderId: vault.userId,
    deviceId: vault.device.id,
    revision,
    nonce: enc(nonce),
    ciphertext: enc(
      sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        JSON.stringify(body),
        associated,
        null,
        nonce,
        key,
      ),
    ),
    keys: [...roster.devices]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((device) => ({
        deviceId: device.id,
        key: enc(sodium.crypto_box_seal(key, dec(device.box_key))),
      })),
  };
  const signature = enc(
    sodium.crypto_sign_detached(
      JSON.stringify(signingBody(value)),
      dec(vault.device.signingSecret),
    ),
  );
  sodium.memzero(key);
  return { ...value, signature };
}
export function openMessage(vault, message) {
  const value = message.encrypted_payload;
  if (!value || message.is_deleted || message.deleted_at) return message;
  if (
    value.scheme !== SCHEME ||
    value.roomId !== message.room_id ||
    value.clientId !== message.client_id ||
    value.senderId !== message.sender_id
  )
    throw new Error("Encrypted message context does not match.");
  checkRoot(vault, value.senderId, value.identityKey);
  const source = value.senderCertificate;
  const cert = source
    ? certificate(source.userId, {
        id: source.deviceId,
        boxKey: source.boxKey,
        signingKey: source.signingKey,
      })
    : null;
  if (
    cert?.userId !== value.senderId ||
    cert?.deviceId !== value.deviceId ||
    !sodium.crypto_sign_verify_detached(
      dec(value.senderCertificateSignature),
      JSON.stringify(cert),
      dec(value.identityKey),
    ) ||
    !sodium.crypto_sign_verify_detached(
      dec(value.signature),
      JSON.stringify(signingBody(value)),
      dec(cert.signingKey),
    )
  )
    throw new Error("Encrypted message authenticity could not be verified.");
  const available = [vault.device, ...vault.previousDevices];
  const device = available.find((d) =>
    value.keys.some((k) => k.deviceId === d.id),
  );
  if (!device)
    throw new Error(
      "This device has no key for this message. Link an older device or restore its encrypted backup.",
    );
  const wrapped = value.keys.find((k) => k.deviceId === device.id);
  const key = sodium.crypto_box_seal_open(
    dec(wrapped.key),
    dec(device.boxKey),
    dec(device.boxSecret),
  );
  const associated = JSON.stringify({
    scheme: SCHEME,
    roomId: value.roomId,
    clientId: value.clientId,
    senderId: value.senderId,
    revision: value.revision,
  });
  let body;
  try {
    body = JSON.parse(
      sodium.to_string(
        sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          dec(value.ciphertext),
          associated,
          dec(value.nonce),
          key,
        ),
      ),
    );
  } finally {
    sodium.memzero(key);
  }
  if (
    body.roomId !== message.room_id ||
    body.clientId !== message.client_id ||
    body.senderId !== message.sender_id ||
    typeof body.content !== "string"
  )
    throw new Error("Invalid encrypted message body.");
  if (
    body.threadRootId !== undefined &&
    body.threadRootId !== message.thread_root_id
  )
    throw new Error("Encrypted thread context does not match");
  const attachments = (message.attachments || []).map((attachment) => {
    if (!body.file || body.file.url !== attachment.url)
      throw new Error("Encrypted attachment does not match this message.");
    return {
      ...attachment,
      ...body.file.metadata,
      crypto: body.file.crypto,
      ciphertext_size: attachment.size,
      encrypted: true,
    };
  });
  return {
    ...message,
    content: body.content,
    attachments,
    _decrypted: true,
    _cryptoError: null,
  };
}
export async function sealFile(blob, roomId, clientId) {
  const key = sodium.randombytes_buf(32),
    nonce = sodium.randombytes_buf(24),
    associated = `${SCHEME}:file:${roomId}:${clientId}`;
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new Uint8Array(await blob.arrayBuffer()),
    associated,
    null,
    nonce,
    key,
  );
  const encrypted = new Blob(["CCEF1", nonce, ciphertext], {
    type: ENCRYPTED_MIME,
  });
  return {
    blob: encrypted,
    crypto: { key: enc(key), associated },
    size: blob.size,
  };
}
export async function openFile(blob, descriptor, mime) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "CCEF1")
    throw new Error("Invalid encrypted attachment.");
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    bytes.subarray(29),
    descriptor.associated,
    bytes.subarray(5, 29),
    dec(descriptor.key),
  );
  return new Blob([plaintext], { type: mime || "application/octet-stream" });
}
export function sealBackup(vault) {
  const key = sodium.randombytes_buf(32),
    nonce = sodium.randombytes_buf(24);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    JSON.stringify(vault),
    `${SCHEME}:backup:${vault.userId}`,
    null,
    nonce,
    key,
  );
  return {
    recoveryKey: enc(key),
    payload: { scheme: SCHEME, nonce: enc(nonce), ciphertext: enc(ciphertext) },
  };
}
export function openBackup(userId, payload, recoveryKey) {
  if (payload.scheme !== SCHEME) throw new Error("Unsupported backup.");
  const value = JSON.parse(
    sodium.to_string(
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        dec(payload.ciphertext),
        `${SCHEME}:backup:${userId}`,
        dec(payload.nonce),
        dec(recoveryKey),
      ),
    ),
  );
  if (value.userId !== userId || !value.identitySecret)
    throw new Error("This backup does not belong to this account.");
  return validateVault(value);
}
export function sealLink(vault, device) {
  const target = {
    id: device.id,
    boxKey: device.box_key,
    signingKey: device.signing_key,
  };
  return {
    signature: enc(
      sodium.crypto_sign_detached(
        JSON.stringify(certificate(vault.userId, target)),
        dec(vault.identitySecret),
      ),
    ),
    payload: enc(
      sodium.crypto_box_seal(JSON.stringify(vault), dec(device.box_key)),
    ),
  };
}
export function openLink(pending, payload) {
  const old = JSON.parse(
    sodium.to_string(
      sodium.crypto_box_seal_open(
        dec(payload),
        dec(pending.device.boxKey),
        dec(pending.device.boxSecret),
      ),
    ),
  );
  if (old.userId !== pending.userId || !old.identitySecret)
    throw new Error("Invalid device link.");
  return validateVault({
    ...old,
    previousDevices: [...old.previousDevices, old.device],
    device: pending.device,
  });
}
