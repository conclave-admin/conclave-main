import { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { getMessageReceipts } from '../../services/messages.service';
import { useRealtime } from '../../contexts/RealtimeContext';

const time = value => value ? new Date(value).toLocaleString() : 'Time unavailable';
export default function MessageInfoDialog({ message, onClose }) {
  const { socket } = useRealtime();
  const [details, setDetails] = useState(null); const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!message?.id) return undefined;
    let active = true; let request = 0;
    setDetails(null); setError('');
    const load = async () => {
      const version = ++request;
      try { const result = await getMessageReceipts(message.id); if (active && version === request) { setDetails(result); setError(''); } }
      catch (err) { if (active && version === request) setError(err.response?.data?.message || 'Could not load message information. Try again when connected.'); }
    };
    const update = payload => { if (payload.receipts?.some(item => item.messageId === message.id)) load(); };
    load(); socket?.on('message:receipts', update); socket?.on('connect', load);
    return () => { active = false; socket?.off('message:receipts', update); socket?.off('connect', load); };
  }, [message?.id, socket, refresh]);
  return <Modal open={Boolean(message)} title="Message information" onClose={onClose}>
    {error && <div role="alert"><p className="text-body text-error">{error}</p><Button variant="secondary" onClick={() => setRefresh(n => n + 1)}>Retry</Button></div>}
    {!details && !error && <p role="status" className="text-body text-muted">Loading receipt details…</p>}
    {details && <div className="space-y-4">
      <p className="text-body text-muted">Sent {time(details.sentAt)}</p>
      <p className="text-body text-ink">Delivered to {details.summary.delivered_count} of {details.summary.recipient_count} · Read by {details.summary.read_count} of {details.summary.recipient_count}</p>
      {!details.summary.history_complete && <p className="text-metadata text-muted">Recipient history is incomplete for this older message. Only known recipients are shown; historical acknowledgement times may be unavailable.</p>}
      {!details.recipients.length && <p className="text-body text-muted">No other recipients when this message was sent.</p>}
      <ul className="divide-y divide-line">{details.recipients.map(recipient => <li key={recipient.user_id} className="min-w-0 py-3">
        <p className="break-words text-label text-ink">{recipient.display_name}{!recipient.current_member && <span className="ml-2 text-metadata text-muted">No longer in this conversation</span>}</p>
        <p className="text-metadata text-muted">{recipient.read ? `Read · ${time(recipient.read_at)}` : 'Not read'}</p>
        <p className="text-metadata text-muted">{recipient.delivered ? `Delivered · ${time(recipient.delivered_at)}` : 'Not delivered'}</p>
      </li>)}</ul>
    </div>}
  </Modal>;
}
