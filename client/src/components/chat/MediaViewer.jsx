import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../ui/Modal';
import useAttachmentImage from '../../hooks/useAttachmentImage';
import useAttachmentDownload from '../../hooks/useAttachmentDownload';
import { saveAttachmentToDevice } from '../../services/attachments.service';
const Context = createContext(null);
export const useMediaViewer = () => useContext(Context);

function ViewerItem({ item, move, onJump, onClose }) {
  const { attachment, message } = item;
  const image = attachment.mime_type?.startsWith('image/');
  const preview = useAttachmentImage(attachment, { enabled: image });
  const download = useAttachmentDownload(attachment);
  const [src, setSrc] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  useEffect(() => { download.start(); }, [item.key]);
  useEffect(() => { setDecodeFailed(false); }, [src, preview.src]);
  useEffect(() => {
    if (!download.blob) { setSrc(null); return; }
    const url = URL.createObjectURL(download.blob); setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [download.blob]);
  useEffect(() => {
    const key = (event) => {
      if (event.target.closest?.('input,textarea,video')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
      if (image && ['+', '='].includes(event.key)) setZoom((value) => Math.min(4, value + 0.5));
      if (image && event.key === '-') setZoom((value) => Math.max(1, value - 0.5));
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [move, image]);
  const pointerDown = (event) => {
    if (event.target.closest?.('video,button')) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) gesture.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
    if (pointers.current.size === 2) {
      const [a,b] = [...pointers.current.values()];
      gesture.current = { distance: Math.hypot(a.x-b.x, a.y-b.y), zoom };
    }
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Pointer already ended. */ }
  };
  const pointerMove = (event) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (image && pointers.current.size === 1 && zoom > 1 && gesture.current?.x !== undefined) {
      event.currentTarget.scrollLeft = gesture.current.left + gesture.current.x - event.clientX;
      event.currentTarget.scrollTop = gesture.current.top + gesture.current.y - event.clientY;
    }
    if (image && pointers.current.size === 2 && gesture.current?.distance) {
      const [a,b] = [...pointers.current.values()];
      setZoom(Math.max(1, Math.min(4, gesture.current.zoom * Math.hypot(a.x-b.x, a.y-b.y) / gesture.current.distance)));
    }
  };
  const pointerUp = (event) => {
    const start = gesture.current;
    if (pointers.current.size === 1 && start && !start.distance && zoom === 1) {
      const dx = event.clientX-start.x; const dy = event.clientY-start.y;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 70) move(dx < 0 ? 1 : -1);
    }
    pointers.current.delete(event.pointerId);
    if (!pointers.current.size) gesture.current = null;
  };
  const save = async () => { const blob = await download.start(); if (blob) saveAttachmentToDevice(attachment, blob); };
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-3 border-b border-line px-3 py-2 text-label">
      {image && <><button type="button" aria-label="Zoom out" onClick={() => setZoom((v) => Math.max(1,v-0.5))}>−</button>
        <span aria-live="polite">{Math.round(zoom*100)}%</span><button type="button" aria-label="Zoom in" onClick={() => setZoom((v) => Math.min(4,v+0.5))}>+</button>
        <button type="button" onClick={() => setZoom(1)}>Reset zoom</button></>}
      <button type="button" onClick={save} disabled={download.status === 'downloading'} className="text-brand disabled:opacity-50">Download</button>
      {onJump && <button type="button" onClick={() => { onClose(); onJump(message); }}>Show message</button>}
    </div>
    <div data-testid="media-viewer-surface" className="min-h-0 flex-1 overflow-auto bg-canvas p-3" style={{ touchAction: image ? 'none' : 'pan-y' }}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { pointers.current.clear(); gesture.current = null; }}>
      {image ? (src || preview.src) && !decodeFailed && <img src={src || preview.src} alt={attachment.filename}
        onError={() => setDecodeFailed(true)} onDoubleClick={() => setZoom((v) => v === 1 ? 2 : 1)} draggable={false}
        style={zoom === 1 ? { maxHeight: '100%', maxWidth: '100%', margin: 'auto', objectFit: 'contain' } : { width: `${zoom*100}%`, maxWidth: 'none', height: 'auto' }} />
        : src && <video src={src} controls playsInline poster={attachment.preview_url || undefined} aria-label={attachment.filename}
          onError={() => setDecodeFailed(true)} className="mx-auto h-full max-h-full max-w-full" />}
      {decodeFailed && <p role="alert">This browser cannot display this file. Download it to open in another app.</p>}
    </div>
    <div className="max-h-36 shrink-0 overflow-auto border-t border-line px-4 py-3 text-metadata">
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.content}</p>
      <p role="status">{download.status === 'downloading' ? `Downloading ${Math.round(download.progress*100)}%`
        : download.status === 'downloaded' ? download.persisted ? 'Downloaded · available offline' : 'Available this visit · could not save offline'
        : download.status === 'failed' ? 'Download failed' : 'Original not downloaded'}</p>
      {download.status === 'downloading' && <><progress max="1" value={download.progress} aria-label={`Downloading ${attachment.filename}`} className="w-full accent-brand" />
        <button type="button" onClick={download.cancel}>Cancel download</button></>}
      {download.error && <p role="alert" className="break-words text-error">{download.error}</p>}
      {['available','failed'].includes(download.status) && <button type="button" onClick={download.start} className="text-brand">{download.status === 'failed' ? 'Retry download' : 'Download original'}</button>}
    </div>
  </div>;
}
export function MediaViewerProvider({ items, onJump, children }) {
  const [activeKey, setActiveKey] = useState(null);
  const index = items.findIndex((item) => item.key === activeKey);
  const active = index >= 0 ? items[index] : null;
  const close = () => setActiveKey(null);
  const move = (delta) => setActiveKey((key) => {
    const current = items.findIndex((item) => item.key === key);
    return items[Math.max(0, Math.min(items.length-1, current+delta))]?.key || null;
  });
  const value = useMemo(() => ({ open: (attachment) => {
    const item = items.find((entry) => entry.attachment === attachment || (attachment.id && entry.attachment.id === attachment.id) || entry.attachment.url === attachment.url);
    if (item) setActiveKey(item.key);
  } }), [items]);
  return <Context.Provider value={value}>{children}
    <Modal open={Boolean(active)} onClose={close} title={<span className="block max-w-[75vw] truncate">{active?.attachment.filename || 'Media'}</span>} fullscreen>
      {active && <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2 text-label">
          <button type="button" disabled={index === 0} aria-label="Previous media" onClick={() => move(-1)} className="disabled:opacity-30">Previous</button>
          <span>{index+1} of {items.length}</span>
          <button type="button" disabled={index === items.length-1} aria-label="Next media" onClick={() => move(1)} className="disabled:opacity-30">Next</button>
        </div>
        <div className="min-h-0 flex-1"><ViewerItem key={active.key} item={active} move={move} onJump={onJump} onClose={close} /></div>
      </div>}
    </Modal>
  </Context.Provider>;
}
