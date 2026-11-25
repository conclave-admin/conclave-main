import { api } from "../lib/api";

const cache = new Map();
const pending = new Map();

export function firstHttpUrl(text = "") {
  const match = String(text).match(/https?:\/\/[^\s<>"']+/i)?.[0];
  return match?.replace(/[),.!?;:]+$/g, "") || null;
}

export async function getLinkPreview(url) {
  if (!url) return null;
  if (cache.has(url)) return cache.get(url);
  if (pending.has(url)) return pending.get(url);
  const request = api
    .get("/links/preview", { params: { url } })
    .then(({ data }) => {
      const preview = data?.data || null;
      if (cache.size > 250) cache.clear();
      cache.set(url, preview);
      return preview;
    })
    .catch(() => {
      cache.set(url, null);
      return null;
    })
    .finally(() => pending.delete(url));
  pending.set(url, request);
  return request;
}
