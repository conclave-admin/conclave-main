import { api } from "@/lib/api";

export async function listCallHistory() {
  const { data } = await api.get("/calls/history");
  return data.data.calls;
}

export async function listPendingCalls() {
  const { data } = await api.get("/calls/pending");
  return data.data.calls;
}

export async function getCallIceServers() {
  const { data } = await api.get("/calls/ice-servers");
  return data.data;
}

export async function endCallByApi(callId) {
  const { data } = await api.post(`/calls/end/${callId}`);
  return data.data;
}
