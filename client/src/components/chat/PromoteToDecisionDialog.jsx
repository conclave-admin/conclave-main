import { useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Textarea from '@/components/ui/Textarea';
import { promoteToDecision } from '@/services/decisions.service';

/**
 * Promote a message to a decision.
 *
 * The message body is prefilled into the body field, because most promotions
 * are a restatement of what was already said — and an empty body field would
 * make the reader retype it. The title has no prefill: a decision titled with
 * the first twelve words of a message is a decision nobody can find again, and
 * a title worth searching for is the one thing the flow genuinely needs from a
 * person.
 *
 * Tags are optional and typed as comma-separated words, which the server
 * lowercases and stores. There is no tag autocomplete because there is no
 * endpoint listing a room's existing tags — offering suggestions that do not
 * exist would be worse than none.
 */
export default function PromoteToDecisionDialog({ open, onClose, message, roomId, onPromoted }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  // Reset whenever the dialog opens on a different message, so a cancelled
  // promotion cannot leave its draft sitting in the next one.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setBody(message?.content || '');
    setTags('');
    setError('');
  }, [open, message]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!title.trim() || !body.trim()) return;

    setIsSaving(true);
    setError('');
    try {
      const decision = await promoteToDecision({
        roomId,
        sourceMessageId: message?.id,
        title: title.trim(),
        body: body.trim(),
        tags: tags
          .split(',')
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean),
      });
      onPromoted?.(decision);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not promote this message.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Promote to decision"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="promote-form" disabled={!title.trim() || !body.trim() || isSaving}>
            {isSaving ? 'Promoting…' : 'Promote'}
          </Button>
        </>
      }
    >
      <form id="promote-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        {message?.content && (
          <blockquote className="rounded-lg border-l-2 border-line bg-canvas px-3 py-2 text-metadata text-muted [overflow-wrap:anywhere]">
            {message.content}
          </blockquote>
        )}

        <Input
          id="promote-title"
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What was decided"
          required
        />

        <Textarea
          id="promote-body"
          label="Body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={5}
          maxRows={12}
          placeholder="Why, and what it means"
          required
        />

        <Input
          id="promote-tags"
          label="Tags (optional)"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder="upload, limits"
        />

        {error && (
          <p role="alert" className="text-metadata text-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
