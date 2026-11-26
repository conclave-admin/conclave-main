import { useCallback, useState } from "react";

export default function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // Storage blocked or full. The preference just will not persist.
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, update];
}
