import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Toast from '@/components/ui/Toast';

const ToastContext = createContext(null);

// Long enough to read a sentence, short enough not to become furniture.
const AUTO_DISMISS_MS = 5000;

/**
 * Owns the toast list and renders the stack.
 *
 * Timers live in a ref rather than on the toast objects so that clearing them
 * on unmount does not need the current state in the effect's closure. A timer
 * left running after the provider is gone would fire into a dead setter.
 *
 * @param {React.ReactNode} children
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback(
    (options) => {
      const id = (nextId.current += 1);
      timers.current.set(id, window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
      setToasts((current) => [...current, { ...options, id }]);
      return id;
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    },
    [],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        // Bottom-centred on a phone, where the sheet and the keyboard both live
        // at the bottom; top-right on desktop, out of the way of the composer.
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 md:inset-x-auto md:right-6 md:top-6 md:bottom-auto md:items-end">
          {toasts.map((item) => (
            <div key={item.id} className="w-full max-w-sm motion-safe:animate-fade-in md:w-auto">
              <Toast {...item} onDismiss={() => dismiss(item.id)} />
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider');
  return context;
}
