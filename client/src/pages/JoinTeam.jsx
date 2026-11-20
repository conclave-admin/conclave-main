import { useEffect,useState } from 'react';
import { Link,useNavigate } from 'react-router-dom';
import AuthLayout from '@/components/layout/AuthLayout';
import { useAuth } from '@/contexts/AuthContext';
import { acceptInvite,previewInvite } from '@/services/teams.service';

// Invitation capabilities survive SPA sign-in only in memory. Reload requires
// reopening the original link; never retain the token in browser storage.
let pendingInvitation='';
window.addEventListener('conclave:session-ended',()=>{pendingInvitation='';});
export default function JoinTeam(){
  const {isAuthenticated,isLoading}=useAuth();
  const navigate=useNavigate();
  const [token,setToken]=useState(()=>new URLSearchParams(location.hash.slice(1)).get('token')||pendingInvitation);
  const [preview,setPreview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{sessionStorage.removeItem('conclave:pending-team-invitation');if(token){pendingInvitation=token;if(location.hash)history.replaceState(null,'',location.pathname);}},[token]);
  useEffect(()=>{const clear=()=>{pendingInvitation='';setToken('');setPreview(null);};window.addEventListener('conclave:session-ended',clear);return()=>window.removeEventListener('conclave:session-ended',clear);},[]);
  useEffect(()=>{if(!isAuthenticated||isLoading||!token)return;let live=true;
    previewInvite(token).then(x=>{if(live)setPreview(x);}).catch(e=>{if(live)setError(e.response?.data?.message||'Invitation unavailable');});
    return()=>{live=false;};},[isAuthenticated,isLoading,token]);
  return <AuthLayout title="Join a team" description="Get started together in Conclave">
    {!token?<p role="alert">This invitation link is incomplete.</p>:isLoading?<p>Restoring your account…</p>:!isAuthenticated?<div className="space-y-3"><p>Sign in or register, then return here to accept the invitation.</p><Link className="block text-brand underline" to="/login">Sign in</Link><Link className="block text-brand underline" to="/register">Create account</Link></div>:<div className="space-y-4">
      {preview&&<p className="text-body">{preview.inviter} invited you to <strong>{preview.name}</strong>. Joining adds you to its general room; other rooms require separate access.</p>}
      {preview?.email_bound&&<p className="text-body text-muted">Your account must have the invited email address verified before accepting.</p>}
      <button className="min-h-11 rounded-xl bg-brand px-4 text-white disabled:opacity-50" disabled={!preview||busy} onClick={async()=>{setBusy(true);setError('');try{const r=await acceptInvite(token);pendingInvitation='';navigate(`/teams/${r.teamId}`,{replace:true});}catch(e){setError(e.response?.data?.message||'Could not accept invitation');}finally{setBusy(false);}}}>Accept invitation</button>
      {error&&<p role="alert" className="text-error">{error}</p>}
    </div>}
  </AuthLayout>;
}
