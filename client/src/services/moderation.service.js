import api from "@/services/api";

const data = (promise) => promise.then((response) => response.data.data);
export const listReports = (params) => data(api.get("/moderation/reports", { params }));
export const getStorageOverview = () => data(api.get("/moderation/storage"));
export const getReport = (id) => data(api.get(`/moderation/reports/${id}`));
export const transitionReport = (id, payload) => data(api.patch(`/moderation/reports/${id}`, payload));
export const suspendAccount = (id, reason) => data(api.post(`/moderation/users/${id}/suspend`, { reason }));
export const restoreAccount = (id, reason) => data(api.post(`/moderation/users/${id}/restore`, { reason }));
