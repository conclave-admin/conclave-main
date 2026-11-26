import axios from "axios";
import { api } from "../lib/api";
import { uploadFile } from "./messages.service";
import { transferMultipart } from "../lib/multipartUpload";
let capabilities;
export async function mediaCapabilities(signal) {
  if (capabilities) return capabilities;
  try {
    const { data } = await api.get("/upload/capabilities", { signal });
    capabilities = data.data;
  } catch (error) {
    if (error.response?.status !== 404) throw error;
    capabilities = { multipart: false };
  }
  return capabilities;
}
const transport = {
  create: async (body, signal) =>
    (await api.post("/upload/sessions", body, { signal })).data.data,
  get: async (id, signal) =>
    (await api.get(`/upload/sessions/${id}`, { signal })).data.data,
  sign: async (id, partNumber, signal) =>
    (await api.post(`/upload/sessions/${id}/parts`, { partNumber }, { signal }))
      .data.data,
  complete: async (id, signal) =>
    (await api.post(`/upload/sessions/${id}/complete`, {}, { signal })).data
      .data,
  put: async (url, blob, { signal, onProgress }) => {
    // A separate Axios instance: never send API bearer tokens to R2.
    const result = await axios.put(url, blob, {
      signal,
      withCredentials: false,
      headers: { "Content-Type": "application/octet-stream" },
      onUploadProgress: (event) => {
        if (event.total) onProgress?.(event.loaded / event.total);
      },
    });
    return result.headers.etag;
  },
};
export async function uploadMedia(blob, options) {
  const config = await mediaCapabilities(options.signal);
  return config.multipart || options.session?.id
    ? transferMultipart(blob, options, transport)
    : uploadFile(blob, options);
}
export async function cancelMediaSession(session) {
  if (!session?.id) return;
  await api.delete(`/upload/sessions/${session.id}`);
}
