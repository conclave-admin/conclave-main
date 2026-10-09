import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import IconMore from '@/assets/icons/more-vertical.svg?react';
import EmptyState from '@/components/ui/EmptyState';
import PopoverMenu from '@/components/ui/PopoverMenu';
import Spinner from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { TASK_STATUSES, listTasks, updateTaskStatus } from '@/services/tasks.service';

const COLUMNS = [
  { status: 'open', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'done', label: 'Done' },
];

/**
 * Format a `YYYY-MM-DD` string.
 *
 * Deliberately not `new Date(due_date)`: that parses the string as UTC
 * midnight, and toLocaleDateString renders it in local time — so anywhere
 * behind UTC the date comes out a day early. Parsing the parts directly keeps
 * the server's calendar date intact wherever the reader is.
 */
function formatDueDate(value) {
  if (!value) return null;
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function StatusMenu({ task, onMove, disabled }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);

  const current = COLUMNS.find((column) => column.status === task.status)?.label || task.status;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Move "${task.title}" to another column`}
        className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-40"
      >
        <IconMore className="h-4 w-4" aria-hidden="true" />
      </button>

      <PopoverMenu
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        align="end"
        label={`Move "${task.title}" to another column`}
        className="w-40"
      >
          {COLUMNS.map((column) => (
            <button
              key={column.status}
              type="button"
              role="menuitemradio"
              aria-checked={column.status === task.status}
              disabled={column.status === task.status || disabled}
              onClick={() => {
                setOpen(false);
                onMove(task, column.status);
              }}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-body text-ink transition-colors hover:bg-canvas disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent"
            >
              {column.label}
              {column.status === task.status && <span aria-hidden="true">·</span>}
            </button>
          ))}
      </PopoverMenu>
    </div>
  );
}

function TaskCard({ task, onMove, disabled }) {
  const isDone = task.status === 'done';
  const due = formatDueDate(task.due_date);

  return (
    <article className="rounded-xl border border-line bg-surface px-5 pt-6 pb-6 md:px-6 md:pt-7 md:pb-7">
      <div className="flex items-start justify-between gap-2">
        <p className={`text-label ${isDone ? 'text-success' : 'text-warning'}`}>
          {isDone ? 'COMPLETE' : 'ACTION ITEM'}
        </p>
        <StatusMenu task={task} onMove={onMove} disabled={disabled} />
      </div>

      <p className="mt-3 text-h2 text-ink [overflow-wrap:anywhere]">{task.title}</p>

      <p className="mt-4 text-metadata text-muted">
        {task.assignee_name ? `Assigned to ${task.assignee_name}` : 'Unassigned'}
        {due ? ` · Due ${due}` : ''}
      </p>

      {/* Room is shown on every card because the board is cross-room. Without
          it a column is an undifferentiated pile and there is no way to tell
          which conversation a task came from. */}
      <p className="mt-1 text-metadata text-muted">#{task.room_slug ?? task.room_name}</p>
    </article>
  );
}

/**
 * The tasks board.
 *
 * Cross-room, matching the top-level nav item and the endpoint's default. A
 * task is most often remembered as "the upload limit thing" rather than as
 * something in a particular room, so starting from a room picker would hide
 * most of the board behind a choice the reader may not be able to make.
 *
 * Moving a card is a menu rather than drag and drop. Drag has no keyboard or
 * touch equivalent without a second interaction model, and a board whose only
 * affordance is a gesture half the audience cannot perform is not an
 * affordance — it is a hidden control.
 *
 * Cards do not update live for someone sitting on this page. `task:updated` is
 * emitted to the task's room, and joining is per-room and on demand, so a
 * cross-room viewer has not joined any of the rooms listed. That limitation is
 * recorded in tasks.controller.js and needs a per-user subscription to close;
 * this page refreshes on reload instead of pretending otherwise.
 */
export default function Tasks() {
  const { setRoomHeader } = useOutletContext();
  const { toast } = useToast();
  const [tasks, setTasks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [movingId, setMovingId] = useState(null);

  useEffect(() => {
    setRoomHeader('Tasks');
    return () => setRoomHeader(null);
  }, [setRoomHeader]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError('');

    listTasks()
      .then(({ tasks: rows }) => {
        if (active) setTasks(rows);
      })
      .catch((err) => {
        if (active) setError(err.response?.data?.message || 'Could not load tasks.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const handleMove = useCallback(
    async (task, status) => {
      if (status === task.status) return;
      const previous = task.status;
      setMovingId(task.id);
      // Optimistic: the card moves the instant the menu is used, then snaps
      // back if the request fails. Waiting for the round trip makes a board
      // feel broken on a good connection and merely slow on a bad one.
      setTasks((prev) =>
        prev.map((item) => (item.id === task.id ? { ...item, status } : item)),
      );

      try {
        const updated = await updateTaskStatus(task.id, status);
        setTasks((prev) => prev.map((item) => (item.id === task.id ? updated : item)));
      } catch (err) {
        setTasks((prev) =>
          prev.map((item) => (item.id === task.id ? { ...item, status: previous } : item)),
        );
        toast({
          title: 'Could not move task',
          description: err.response?.data?.message || 'The status was not saved.',
          tone: 'error',
        });
      } finally {
        setMovingId(null);
      }
    },
    [toast],
  );

  if (isLoading) return <Spinner label="Loading tasks" />;

  if (error) {
    return (
      <div className="h-full min-h-0 overflow-y-auto bg-surface px-4 pt-6 md:pt-9">
        <p role="alert" className="rounded-lg bg-error/10 p-4 text-body text-error">{error}</p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface px-4 pt-6 md:pt-9">
      {tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line">
          <EmptyState
            title="No tasks yet"
            description="Tasks flagged from room messages will appear here."
          />
        </div>
      ) : (
        // Mobile board stacks the three statuses as full-width sections;
        // Tablet and Desktop show them as a 3-column grid.
        <div className="flex flex-col gap-[26px] md:grid md:grid-cols-3 md:items-start md:gap-4">
          {COLUMNS.map((column) => (
            <section key={column.status}>
              <p className="text-h2 text-ink">
                {column.label} · {tasks.filter((task) => task.status === column.status).length}
              </p>
              {/* 42px "first card below title" is top-to-top; the title's own
                  height makes the real margin-top 22px. Not on the Foundations
                  scale, kept as measured. */}
              <div className="mt-[22px] flex flex-col gap-5">
                {tasks
                  .filter((task) => task.status === column.status)
                  .map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onMove={handleMove}
                      disabled={movingId === task.id}
                    />
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
