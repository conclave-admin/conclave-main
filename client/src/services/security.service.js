import { api } from "../lib/api";
import { isDevAuthBypass, previewUser } from "../config/devPreview";
const preview = {
  online_visibility: "everyone",
  last_seen_visibility: "connections",
  photo_visibility: "everyone",
  about_visibility: "connections",
  read_receipts: true,
  dm_policy: "requests",
};
const PREVIEW_MESSAGE_REQUESTS = "conclave.preview.message-requests";
const previewRequest = {
  room_id: "preview-dm",
  sender_id: "dev-victor",
  recipient_id: previewUser.id,
  sender_name: "Victor",
  sender_avatar: null,
  status: "pending",
  created_at: "2026-11-20T09:00:00.000Z",
  declined_at: null,
};

function previewRequests() {
  try {
    const value = JSON.parse(localStorage.getItem(PREVIEW_MESSAGE_REQUESTS));
    return Array.isArray(value) ? value : [{ ...previewRequest }];
  } catch {
    return [{ ...previewRequest }];
  }
}

function savePreviewRequests(value) {
  localStorage.setItem(PREVIEW_MESSAGE_REQUESTS, JSON.stringify(value));
}
export async function getPrivacy() {
  return isDevAuthBypass
    ? { ...preview }
    : (await api.get("/security/privacy")).data.data;
}
export async function savePrivacy(value) {
  if (isDevAuthBypass) return Object.assign(preview, value);
  return (await api.patch("/security/privacy", value)).data.data;
}
export async function getSessions() {
  return isDevAuthBypass
    ? []
    : (await api.get("/security/sessions")).data.data.sessions;
}
export async function revokeSession(id, password) {
  return (await api.delete(`/security/sessions/${id}`, { data: { password } }))
    .data.data;
}
export async function renameSession(label) {
  return (await api.patch("/security/session", { label })).data.data;
}
export async function requestVerification() {
  return (await api.post("/security/verification")).data.data;
}
export async function redeemVerificationCode(code) {
  return (await api.post("/security/verification/code", { code })).data.data;
}
export async function requestRecovery(email) {
  return (await api.post("/security/recovery", { email })).data.data;
}
export async function redeemAccountToken(kind, token, password) {
  return (
    await api.post(`/security/${kind === "verify" ? "verify" : "reset"}`, {
      token,
      password,
    })
  ).data.data;
}
export async function respondToRequest(roomId, status) {
  if (isDevAuthBypass) {
    const requests = previewRequests();
    const index = requests.findIndex((request) => request.room_id === roomId);
    if (index < 0) throw new Error("Message request not found");
    const request = requests[index];
    const now = new Date().toISOString();
    if (status === "declined") {
      request.status = "declined";
      request.declined_at = now;
    } else if (status === "undo_decline") {
      if (
        request.status !== "declined" ||
        !request.declined_at ||
        Date.now() - new Date(request.declined_at).getTime() > 10_000
      ) throw new Error("The undo period has ended");
      request.status = "pending";
      request.declined_at = null;
    } else if (status === "accepted") {
      request.status = "accepted";
      request.declined_at = null;
    }
    requests[index] = request;
    savePreviewRequests(requests);
    return { ...request };
  }
  return (await api.post(`/security/requests/${roomId}`, { status })).data.data;
}

export async function getMessageRequests() {
  if (isDevAuthBypass) return previewRequests().filter((request) => request.status !== "accepted");
  return (await api.get("/security/requests")).data.data.requests;
}
