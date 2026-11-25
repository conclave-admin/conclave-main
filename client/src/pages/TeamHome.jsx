import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import Page from '@/components/layout/Page';
import { useAuth } from '@/contexts/AuthContext';
import * as teams from '@/services/teams.service';
import * as work from '@/services/work.service';
import { useChats } from '@/contexts/ChatsContext';

const field='min-h-11 w-full rounded-xl border border-line bg-surface px-3 py-2 text-body text-ink';
const button='min-h-11 rounded-xl bg-brand px-4 py-2 text-label text-white disabled:opacity-50';
const secondary='min-h-11 rounded-xl border border-line bg-surface px-4 py-2 text-label text-ink hover:border-brand disabled:opacity-50';
const card='rounded-2xl border border-line bg-surface p-5';
const errorText=(error)=>error?.response?.data?.message || error?.message || 'Something went wrong. Try again.';
const teamReference=(id)=>id?`TEAM-${id.replaceAll('-','').slice(0,12).toUpperCase()}`:'';

export default function TeamHome(){
  const {teamId}=useParams();
  const navigate=useNavigate();
  const {setRoomHeader}=useOutletContext();
  const {user}=useAuth();
  const {rooms:allRooms,refresh:refreshChats}=useChats();
  const [list,setList]=useState([]),[detail,setDetail]=useState(null),[teamCap,setTeamCap]=useState(25);
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [teamName,setTeamName]=useState(''),[description,setDescription]=useState('');
  const [creationKey,setCreationKey]=useState(()=>crypto.randomUUID());
  const [email,setEmail]=useState(''),[invite,setInvite]=useState(null);
  const [roomName,setRoomName]=useState(''),[projectName,setProjectName]=useState(''),[projectRoomIds,setProjectRoomIds]=useState([]);
  const [roomType,setRoomType]=useState('group');
  const [moveRoomId,setMoveRoomId]=useState(''),[moveProjectId,setMoveProjectId]=useState(''),[preview,setPreview]=useState(null);
  const [legacyProjects,setLegacyProjects]=useState([]);
  const load=useCallback(async()=>{setLoading(true);setError('');try{
    const result=await teams.listTeams();setList(result.teams);setTeamCap(result.maxMembers||25);
    if(teamId){const next=await teams.getTeam(teamId);setDetail(next);localStorage.setItem('conclave:last-team',teamId);}
    else setDetail(null);
  }catch(e){setError(errorText(e));}finally{setLoading(false);}},[teamId]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{
    const clear=()=>{setTeamName('');setDescription('');setRoomName('');setProjectName('');setProjectRoomIds([]);setEmail('');setInvite(null);setError('');};
    clear();
  },[user?.id]);
  useEffect(()=>{setRoomHeader(detail?.team?.name || 'Teams');return()=>setRoomHeader(null);},[detail?.team?.name,setRoomHeader]);
  useEffect(()=>{if(teamId) work.listProjects().then(x=>setLegacyProjects(x.projects.filter(p=>!p.team_id))).catch(()=>{});},[teamId]);
  const act=async(fn)=>{setBusy(true);setError('');try{await fn();await load();}catch(e){setError(errorText(e));}finally{setBusy(false);}};
  const current=detail?.team;
  const admin=current && current.my_role!=='member';
  const legacyRooms=allRooms.filter(r=>r.type!=='dm'&&!r.team_id&&r.my_role==='admin');
  return <Page width="board">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-label uppercase text-brand">TEAM SPACE</p><h1 className="mt-2 text-h1">{current?.name || 'Your teams'}</h1>
        {current&&<p className="mt-1 text-metadata text-muted" title={`Full team ID: ${current.id}`}>{teamReference(current.id)} · team reference</p>}
        <p className="mt-2 text-body text-muted">{current?.description || 'Bring your people, conversations, and projects together.'}</p></div>
      <Link className={secondary} to="/teams">All teams</Link>
    </header>
    {error&&<p role="alert" className="mb-5 rounded-xl bg-error/10 p-3 text-body text-error">{error}</p>}
    {loading&&<p role="status" className="text-body text-muted">Loading teams…</p>}
    {!teamId&&<div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <section className={card}><h2 className="text-h2">Switch teams</h2><div className="mt-4 space-y-2">
        {list.map(t=><Link key={t.id} to={`/teams/${t.id}`} className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-line px-4 hover:border-brand">
          <span className="min-w-0"><span className="block truncate text-label">{t.name}</span><span className="block text-metadata text-muted" title={`Full team ID: ${t.id}`}>{teamReference(t.id)}</span></span><span className="shrink-0 text-right text-metadata text-muted">{t.member_count}/{teamCap} members · {t.my_role}{t.archived_at?' · archived':''}</span></Link>)}
        {!list.length&&!loading&&<p className="text-body text-muted">Create your first team to start a shared conversation.</p>}
      </div><p className="mt-5 text-metadata text-muted">Personal DMs and rooms you have not moved into a team remain in Chats.</p></section>
      <form className={`${card} space-y-4`} onSubmit={e=>{e.preventDefault();void act(async()=>{const t=await teams.createTeam({name:teamName,description,creationKey});setCreationKey(crypto.randomUUID());navigate(`/teams/${t.id}`);});}}>
        <h2 className="text-h2">Create team</h2><p className="text-body text-muted">A general room is created automatically. You can invite people and add a project next.</p>
        <label className="block text-label">Team name<input className={`mt-2 ${field}`} maxLength={120} required value={teamName} onChange={e=>setTeamName(e.target.value)}/></label>
        <label className="block text-label">Description (optional)<textarea className={`mt-2 ${field}`} maxLength={2000} rows={3} value={description} onChange={e=>setDescription(e.target.value)}/></label>
        <button className={button} disabled={busy||!teamName.trim()}>Create team</button>
      </form></div>}
    {current&&<>
      {current.archived_at&&<p className="mb-5 rounded-xl border border-line bg-surface p-3 text-body">This team is archived. Conversations and work are read only until an admin restores it.</p>}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-5">
          <section className={card}><div className="flex items-center justify-between"><h2 className="text-h2">Conversations</h2><span className="text-metadata text-muted">Only rooms you can open</span></div>
            <div className="mt-4 space-y-2">{detail.rooms.map(r=><div className="flex min-h-12 items-center justify-between gap-2 rounded-xl bg-canvas px-4" key={r.id}><Link className="min-w-0 flex-1 truncate text-label hover:text-brand" to={`/chats/${r.id}`}>{r.name}</Link><span className="text-metadata text-muted">{r.my_role}</span>{admin&&r.my_role==='admin'&&r.type==='public'&&!current.archived_at&&<button className="text-metadata text-brand underline" disabled={busy} onClick={()=>void act(()=>teams.setRoomDiscovery(teamId,r.id,!r.team_discoverable))}>{r.team_discoverable?'Hide from discovery':'Show in discovery'}</button>}</div>)}
            {!detail.rooms.length&&<p className="text-body text-muted">No rooms available to you yet. Ask a room admin for access.</p>}</div>
            {!current.archived_at&&<form className="mt-5 flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();void act(async()=>{await teams.createTeamRoom(teamId,{name:roomName,type:roomType});setRoomName('');await refreshChats?.();});}}>
              <input className={`${field} max-w-sm flex-1`} aria-label="New room name" maxLength={120} required placeholder="New room name" value={roomName} onChange={e=>setRoomName(e.target.value)}/><select className={`${field} sm:w-auto`} aria-label="Room visibility" value={roomType} onChange={e=>setRoomType(e.target.value)}><option value="group">Private group</option><option value="public">Public room</option></select><button disabled={busy} className={button}>New room</button></form>}
          </section>
          <section className={card}><h2 className="text-h2">Projects</h2><div className="mt-4 space-y-2">{detail.projects.map(p=><Link className="block rounded-xl bg-canvas px-4 py-3 text-label hover:text-brand" key={p.id} to={`/work/projects/${p.id}`}>{p.name}</Link>)}
            {!detail.projects.length&&<p className="text-body text-muted">No accessible projects yet. Add one when your team is ready.</p>}</div>
            {admin&&!current.archived_at&&<form className="mt-5 space-y-3" onSubmit={e=>{e.preventDefault();void act(async()=>{await teams.createTeamProject(teamId,{name:projectName,roomIds:projectRoomIds});setProjectName('');setProjectRoomIds([]);});}}>
              <input className={`${field} max-w-sm`} aria-label="New project name" maxLength={160} required placeholder="Project name" value={projectName} onChange={e=>setProjectName(e.target.value)}/>
              <fieldset><legend className="text-label">Starting rooms</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{detail.rooms.filter(r=>r.my_role==='admin').map(r=><label key={r.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-body"><input type="checkbox" checked={projectRoomIds.includes(r.id)} onChange={e=>setProjectRoomIds(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/>{r.name}</label>)}</div></fieldset>
              <button disabled={busy||!projectName.trim()||!projectRoomIds.length} className={button}>New project</button></form>}
          </section>
          {admin&&!current.archived_at&&<section className={card}><h2 className="text-h2">Move existing work</h2><p className="mt-2 text-body text-muted">Choose an unassigned room or project. A newly added team owner sees room messages from the move onward.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-label">Room<select className={`mt-2 ${field}`} value={moveRoomId} onChange={e=>{setMoveRoomId(e.target.value);setMoveProjectId('');setPreview(null);}}><option value="">Choose a room</option>{legacyRooms.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
            <label className="text-label">Project<select className={`mt-2 ${field}`} value={moveProjectId} onChange={e=>{setMoveProjectId(e.target.value);setMoveRoomId('');setPreview(null);}}><option value="">Choose a project</option>{legacyProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>
            <div className="mt-3 flex gap-2"><button className={secondary} disabled={busy||(!moveRoomId&&!moveProjectId)} onClick={()=>void act(async()=>setPreview(await teams.previewTransfer(teamId,moveRoomId?{roomId:moveRoomId}:{projectId:moveProjectId})))}>Check move</button>
              {preview&&<button className={button} disabled={busy||preview.blockers.length>0} onClick={()=>void act(async()=>{if(moveRoomId){await teams.moveRoom(teamId,moveRoomId);await refreshChats?.();}else await teams.moveProject(teamId,moveProjectId);setPreview(null);setMoveRoomId('');setMoveProjectId('');})}>Confirm move</button>}</div>
            {preview&&<div role="status" className="mt-3 text-body">{preview.blockers.length?preview.blockers.join('; '):preview.ownerGainsMembership?'Ready. The team owner gains access only to future room history.':'Ready to move.'}</div>}
          </section>}
        </div>
        <div className="space-y-5">
          <section className={card}><h2 className="text-h2">People</h2><p className="mt-1 text-metadata text-muted">{detail.members.length}/{detail.maxMembers||teamCap} members · team membership does not open every room.</p><ul className="mt-4 space-y-3">{detail.members.map(m=><li key={m.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3 text-body"><div><strong className="block text-label">{m.display_name}</strong><span className="text-metadata text-muted">{m.role}{m.email?` · ${m.email}`:''}</span></div>
            {admin&&!current.archived_at&&m.id!==user?.id&&m.role!=='owner'&&<div className="flex items-center gap-2"><select className="rounded-lg border border-line bg-surface px-2 py-1 text-metadata" aria-label={`Role for ${m.display_name}`} value={m.role} disabled={busy||current.my_role!=='owner'} onChange={e=>void act(()=>teams.setRole(teamId,m.id,e.target.value))}><option value="member">Member</option><option value="admin">Admin</option></select><button className="text-metadata text-error underline" disabled={busy} onClick={()=>{if(window.confirm(`Remove ${m.display_name} from this team and its rooms?`)) void act(()=>teams.removeMember(teamId,m.id));}}>Remove</button></div>}</li>)}</ul></section>
          {admin&&!current.archived_at&&<section className={`${card} space-y-3`}><h2 className="text-h2">Invite people</h2><p className="text-body text-muted">Leave email blank for a shareable link. Email invitations require a verified matching address. Teams in this beta can have up to {detail.maxMembers||teamCap} members.</p>
            <input type="email" className={field} aria-label="Invite by email" placeholder="Email address (optional)" value={email} onChange={e=>setEmail(e.target.value)}/>
            <button className={button} disabled={busy||detail.members.length>=(detail.maxMembers||teamCap)} onClick={()=>void act(async()=>setInvite(await teams.createInvite(teamId,{email:email||undefined})))}>Create invitation</button>
            {invite&&<div className="break-all rounded-xl bg-canvas p-3 text-body"><p>{invite.email_normalized?(invite.emailQueued?'Email queued for delivery. Copy this link as a backup.':'Email delivery is unavailable. Copy and send this link yourself.'):'Copy this link now. It will not be shown again.'}</p><input readOnly aria-label="Invitation link" className={`mt-2 ${field}`} value={`${location.origin}/join-team#token=${invite.token}`}/><button className="mt-2 text-label text-brand underline" onClick={()=>navigator.clipboard.writeText(`${location.origin}/join-team#token=${invite.token}`)}>Copy link</button></div>}
            <h3 className="text-label">Recent invitations</h3>{detail.invites.map(i=><div key={i.id} className="flex justify-between gap-2 text-metadata"><span>{i.email_normalized||'Shareable link'} · {i.revoked_at?'revoked':i.uses>=i.max_uses?'used':new Date(i.expires_at)<new Date()?'expired':'active'}</span>{!i.revoked_at&&<button disabled={busy} className="text-error underline" onClick={()=>void act(()=>teams.revokeInvite(teamId,i.id))}>Revoke</button>}</div>)}
          </section>}
          {admin&&detail.requests.length>0&&<section className={`${card} space-y-3`}><h2 className="text-h2">Join requests</h2>{detail.requests.map(request=><div key={request.user_id} className="rounded-xl border border-line p-3 text-body"><p><strong>{request.display_name}</strong> wants to join the team{request.source_room_id?' and a public room':''}.</p>{!current.archived_at&&<div className="mt-2 flex gap-2"><button className={secondary} disabled={busy} onClick={()=>void act(()=>teams.reviewRequest(teamId,request.user_id,'approve'))}>Approve</button><button className={secondary} disabled={busy} onClick={()=>void act(()=>teams.reviewRequest(teamId,request.user_id,'reject'))}>Reject</button></div>}</div>)}</section>}
          {admin&&<section className={`${card} space-y-3`}><h2 className="text-h2">Team settings</h2><button className={secondary} disabled={busy} onClick={()=>void act(()=>current.archived_at?teams.restoreTeam(teamId):teams.archiveTeam(teamId))}>{current.archived_at?'Restore team':'Archive team'}</button>
            {current.my_role==='owner'&&<select className={field} aria-label="Transfer ownership" disabled={busy} defaultValue="" onChange={e=>{if(e.target.value&&window.confirm('Transfer team ownership?')) void act(()=>teams.transferOwner(teamId,e.target.value));}}><option value="">Transfer ownership to…</option>{detail.members.filter(m=>m.id!==user?.id).map(m=><option value={m.id} key={m.id}>{m.display_name}</option>)}</select>}</section>}
          {current.my_role!=='owner'&&!current.archived_at&&<button className={secondary} disabled={busy} onClick={()=>{if(window.confirm('Leave this team and all its rooms?')) void act(async()=>{await teams.leaveTeam(teamId);navigate('/teams');});}}>Leave team</button>}
        </div>
      </div>
    </>}
  </Page>;
}
