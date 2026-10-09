import { useEffect, useMemo, useState } from 'react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Select from '@/components/ui/Select';
import Textarea from '@/components/ui/Textarea';
import { createTask } from '@/services/tasks.service';

/**
 * Flag a message as a task.
 *
 * The title is prefilled from the message, truncated rather than left whole: a
 * task card shows one or two lines, so a full paragraph in the title field
 * would render as a card nobody can scan. The full text stays available in the
 * body field, which is optional.
 *
 * The assignee list is this room's members. The server rejects anyone outside
 * the room with a 400, so offering a wider list would mean a selection that
 * always fails — and the failure arrives after the form is submitted, which is
 * the worst place to discover it.
 *
 * Due date is optional and sent as `YYYY-MM-DD`, the same shape the server
 * returns, so a round trip does not shift a day.
 */
export default function FlagAsTaskDialog({ open, onClose, message, roomId, members = [], onCreated }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const candidates = useMemo(
    () => members.filter((member) => member.id && member.display_name),
    [members],
  );

  useEffect(() => {
    if (!open) return;
    const text = message?.content || '';
    setTitle(text.length > 80 ? `${text.slice(0, 77)}…` : text);
    setBody('');
    setAssigneeId('');
    setDueDate('');
    setError('');
  }, [open, message]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!title.trim()) return;

    setIsSaving(true);
    setError('');
    try {
      const task = await createTask({
        roomId,
        sourceMessageId: message?.id,
        title: title.trim(),
        assigneeId: assigneeId || undefined,
        dueDate: dueDate || undefined,
      });
      onCreated?.(task);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not create this task.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Flag as task"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="flag-task-form" disabled={!title.trim() || isSaving}>
            {isSaving ? 'Creating…' : 'Create task'}
          </Button>
        </>
      }
    >
      <form id="flag-task-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        {message?.content && (
          <blockquote className="rounded-lg border-l-2 border-line bg-canvas px-3 py-2 text-metadata text-muted [overflow-wrap:anywhere]">
            {message.content}
          </blockquote>
        )}

        <Textarea
          id="task-title"
          label="Task"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          rows={2}
          maxRows={4}
          placeholder="What needs doing"
          required
        />

        <Textarea
          id="task-body"
          label="Notes (optional)"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={2}
          maxRows={6}
          placeholder="Anything the assignee should know"
        />

        <Select
          id="task-assignee"
          label="Assign to (optional)"
          value={assigneeId}
          onChange={(event) => setAssigneeId(event.target.value)}
        >
          <option value="">Unassigned</option>
          {candidates.map((member) => (
            <option key={member.id} value={member.id}>
              {member.display_name}
            </option>
          ))}
        </Select>

        <Input
          id="task-due"
          label="Due date (optional)"
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
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
