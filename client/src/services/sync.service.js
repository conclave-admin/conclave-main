import {api} from '../lib/api';
import {isDevAuthBypass} from '../config/devPreview';
export async function readSyncPage(after){
  if(isDevAuthBypass)return{cursor:'0',reset:false,changes:[],hasMore:false};
  return(await api.get('/sync',{params:after===undefined?undefined:{after}})).data.data;
}
