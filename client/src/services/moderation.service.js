import { api } from "@/lib/api";

const data = (promise) => promise.then((response) => response.data.data);
export const listReports = (params) => data(api.get("/moderation/reports", { params }));
export const getStorageOverview = () => data(api.get("/moderation/storage"));
export const getReport = (id) => data(api.get(`/moderation/reports/${id}`));
export const transitionReport = (id, payload) => data(api.patch(`/moderation/reports/${id}`, payload));
export const suspendAccount = (id, reason, reportId) => data(api.post(`/moderation/users/${id}/suspend`, { reason, reportId }));
export const restoreAccount = (id, reason, reportId) => data(api.post(`/moderation/users/${id}/restore`, { reason, reportId }));
export const assignReport = (id, assignedTo) => data(api.patch(`/moderation/reports/${id}/assignment`, { assignedTo }));
export const listModerators = () => data(api.get("/moderation/moderators"));
export const requestAppeal = (payload) => data(api.post("/moderation/appeals/request", payload));
export const getAppealStatus = (payload) => data(api.post("/moderation/appeals/status", payload));
export const listAppeals = (params) => data(api.get("/moderation/appeals", { params }));
export const getAppeal = (id) => data(api.get(`/moderation/appeals/${id}`));
export const assignAppeal = (id, assignedTo) => data(api.patch(`/moderation/appeals/${id}/assignment`, { assignedTo }));
export const transitionAppeal = (id, payload) => data(api.patch(`/moderation/appeals/${id}`, payload));
