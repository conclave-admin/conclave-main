import IconSend from '@/assets/icons/send.svg?react';
import IconChannel from '@/assets/icons/channel.svg?react';
import IconTasks from '@/assets/icons/tasks.svg?react';
import IconDecisions from '@/assets/icons/decisions.svg?react';
import IconPin from '@/assets/icons/pin.svg?react';
import IconImage from '@/assets/icons/image.svg?react';

function Person({ children, className = '' }) {
  return <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand ${className}`}>{children}</span>;
}

// Decorative product illustration. No fake buttons, inputs or live presence.
export default function ChatMock() {
  return (
    <div className="landing-preview overflow-hidden rounded-2xl border border-line bg-surface md:rounded-[22px]" aria-hidden="true">
      <div className="flex h-11 items-center justify-between border-b border-line bg-canvas/60 px-4">
        <div className="flex gap-1.5">{[0,1,2].map(dot => <span key={dot} className="h-2 w-2 rounded-full border border-muted/30 bg-line/50" />)}</div>
        <span className="text-[11px] font-medium tracking-wide text-muted">Your space to connect</span>
        <span className="w-8" />
      </div>
      <div className="landing-preview-layout">
        <aside className="landing-preview-sidebar border-r border-line bg-canvas/45 p-5">
          <div className="flex items-center gap-2.5"><span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm font-semibold text-surface">S</span><span className="text-sm font-semibold">Studio collective</span></div>
          <p className="mb-2 mt-9 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Your rooms</p>
          {['Studio lounge','Website refresh','Ideas & inspiration'].map((room,index) => <div key={room} className={`-mx-2 flex items-center gap-2 rounded-lg px-2 py-3 text-xs ${index===1?'bg-brand-soft font-semibold text-brand':'text-muted'}`}><IconChannel className="h-4 w-4" />{room}{index===0&&<span className="ml-auto rounded bg-line/70 px-1.5 py-0.5 text-[10px]">3</span>}</div>)}
          <p className="mb-3 mt-8 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Direct messages</p>
          <div className="space-y-4">{[['AO','Amara Okafor'],['JL','Jamie Lee']].map(([initials,name]) => <div key={name} className="flex items-center gap-2.5 text-xs text-muted"><Person>{initials}</Person>{name}</div>)}</div>
          <div className="mt-10 flex items-center gap-2 border-t border-line pt-4 text-xs text-muted"><IconTasks className="h-4 w-4" /> Your tasks <span className="ml-auto">2</span></div>
        </aside>
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-4 md:px-6"><div><p className="text-sm font-semibold"><span className="mr-1 text-brand">#</span> Website refresh</p><p className="mt-1 text-[11px] text-muted">A fresh start for our corner of the internet.</p></div><div className="flex -space-x-2"><Person className="border-2 border-surface">AO</Person><Person className="border-2 border-surface">JL</Person><Person className="border-2 border-surface">+2</Person></div></div>
          <div className="flex items-center gap-2 border-b border-line bg-canvas/50 px-4 py-2.5 text-[11px] text-muted md:px-6"><IconPin className="h-3 w-3 shrink-0 text-brand" /><span className="truncate">Pinned decision: A simpler, more welcoming homepage</span></div>
          <div className="space-y-5 px-4 py-5 md:px-6">
            <p className="text-center text-[10px] text-muted">Today, 10:24 AM</p>
            <div className="flex items-start gap-2.5"><Person>AO</Person><div className="min-w-0"><p className="text-[11px] font-semibold">Amara <span className="ml-2 font-normal text-muted">10:24</span></p><div className="mt-2 rounded-xl rounded-tl-none bg-canvas px-3 py-2.5 text-xs leading-relaxed">A little breathing room, a little more personality. What do we think?</div><div className="mt-2 flex max-w-64 items-center gap-3 rounded-xl border border-line bg-canvas p-2.5"><div className="landing-mini-art grid h-16 w-20 shrink-0 place-items-center rounded-lg bg-brand-soft"><span className="font-display text-3xl italic text-brand">hello.</span></div><div className="min-w-0"><p className="truncate text-[11px] font-medium">A fresh perspective.jpg</p><p className="mt-1 flex items-center gap-1 text-[10px] text-muted"><IconImage className="h-3 w-3" /> Photo · 1.2 MB</p></div></div></div></div>
            <div className="ml-10 flex justify-end"><div className="max-w-72 rounded-xl rounded-br-none bg-brand px-3.5 py-3 text-xs leading-relaxed text-surface">This feels like us. Let’s go with this direction.<span className="mt-1 block text-right text-[10px] opacity-80">10:26 · ✓✓</span></div></div>
            <div className="flex items-start gap-2.5"><Person>JL</Person><div className="min-w-0"><p className="text-[11px] font-semibold">Jamie <span className="ml-2 font-normal text-muted">10:28</span></p><p className="mt-2 text-xs leading-relaxed text-muted">I’ll put the first draft together for Friday.</p><div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[11px]"><IconTasks className="h-3.5 w-3.5 text-brand" /> Homepage draft <span className="text-muted">· Fri</span></div></div></div>
          </div>
          <div className="mx-4 mb-4 flex min-h-11 items-center gap-3 rounded-xl border border-line px-3 text-xs text-muted md:mx-6"><span className="text-lg">+</span><span className="flex-1">Message Website refresh…</span><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-surface"><IconSend className="h-3.5 w-3.5" /></span></div>
        </div>
        <aside className="landing-preview-details border-l border-line bg-canvas/35 p-5">
          <p className="text-xs font-semibold">The bigger picture</p><p className="mt-2 text-[11px] leading-relaxed text-muted">Less searching. More moving forward.</p>
          <div className="mt-7 rounded-xl border border-line bg-surface p-3.5"><IconDecisions className="h-4 w-4 text-brand" /><p className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-muted">Decided together</p><p className="mt-2 text-xs leading-relaxed">A simpler, more welcoming homepage.</p><p className="mt-3 text-[10px] text-muted">Today · Saved in this room</p></div>
          <p className="mb-3 mt-7 text-[10px] font-semibold uppercase tracking-wider text-muted">Next up</p>
          {['Homepage draft','Gather team feedback'].map((task,index) => <div key={task} className="flex items-start gap-2 border-b border-line py-3 text-[11px]"><span className="mt-0.5 h-3 w-3 shrink-0 rounded border border-muted/50" /><div>{task}<p className="mt-1 text-[10px] text-muted">{index?'Amara · Monday':'Jamie · Friday'}</p></div></div>)}
          <p className="mt-7 text-[11px] leading-relaxed text-muted">Back after a break?<br /><span className="font-medium text-brand">Your catch-up is waiting.</span></p>
        </aside>
      </div>
    </div>
  );
}
