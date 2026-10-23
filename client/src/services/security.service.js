import {api} from '../lib/api';
import {isDevAuthBypass} from '../config/devPreview';
const preview={online_visibility:'everyone',last_seen_visibility:'connections',photo_visibility:'everyone',about_visibility:'connections',read_receipts:true,dm_policy:'requests'};
export async function getPrivacy(){return isDevAuthBypass?{...preview}:(await api.get('/security/privacy')).data.data;}
export async function savePrivacy(value){if(isDevAuthBypass)return Object.assign(preview,value);return(await api.patch('/security/privacy',value)).data.data;}
export async function getSessions(){return isDevAuthBypass?[]:(await api.get('/security/sessions')).data.data.sessions;}
export async function revokeSession(id,password){return(await api.delete(`/security/sessions/${id}`,{data:{password}})).data.data;}
export async function renameSession(label){return(await api.patch('/security/session',{label})).data.data;}
export async function requestVerification(){return(await api.post('/security/verification')).data.data;}
export async function requestRecovery(email){return(await api.post('/security/recovery',{email})).data.data;}
export async function redeemAccountToken(kind,token,password){return(await api.post(`/security/${kind==='verify'?'verify':'reset'}`,{token,password})).data.data;}
export async function respondToRequest(roomId,status){return(await api.post(`/security/requests/${roomId}`,{status})).data.data;}
