import { api } from "../lib/api";

export async function createPoll({ roomId, question, options, allowMultiple }) {
  const { data } = await api.post("/polls", {
    roomId,
    question,
    options,
    allowMultiple,
  });
  return data.data;
}

// An empty list removes the caller's vote.
export async function votePoll(pollId, optionIds) {
  const { data } = await api.put(`/polls/${pollId}/vote`, { optionIds });
  return data.data;
}

export async function closePoll(pollId) {
  const { data } = await api.post(`/polls/${pollId}/close`);
  return data.data;
}
