import { useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";

let pickerModules;
function loadPicker() {
  pickerModules ||= Promise.all([
    import("@emoji-mart/react"),
    import("@emoji-mart/data"),
  ]);
  return pickerModules;
}

export default function EmojiPicker({ onPick }) {
  const { resolved } = useTheme();
  const [picker, setPicker] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    loadPicker()
      .then(([component, catalog]) => {
        if (active)
          setPicker({ Component: component.default, data: catalog.default });
      })
      .catch(() => {
        pickerModules = null;
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  if (error)
    return (
      <p role="alert" className="p-3 text-metadata text-error">
        Emoji could not load. Close the picker and try again.
      </p>
    );
  if (!picker)
    return (
      <p role="status" className="p-3 text-metadata text-muted">
        Loading emoji…
      </p>
    );

  const { Component, data } = picker;
  return (
    <div className="emoji-mart-panel w-full">
      <Component
        data={data}
        set="native"
        theme={resolved}
        dynamicWidth
        previewPosition="none"
        maxFrequentRows={1}
        onEmojiSelect={(emoji) => onPick(emoji.native)}
      />
    </div>
  );
}
