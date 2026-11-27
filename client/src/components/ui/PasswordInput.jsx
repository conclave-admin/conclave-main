import { useState } from "react";
import PreviewIcon from "@/assets/icons/preview.svg?react";
import HiddenIcon from "@/assets/icons/hidden.svg?react";

export default function PasswordInput({ id, label = "Password", error, ...props }) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? HiddenIcon : PreviewIcon;
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-ink">{label}</label>
      <div className="relative">
        <input
          {...props}
          id={id}
          type={visible ? "text" : "password"}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`min-h-12 w-full rounded-xl border bg-canvas/60 pl-3.5 pr-14 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-2 focus:ring-brand/15 ${error ? "border-error" : "border-line"}`}
        />
        <button
          type="button"
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          aria-controls={id}
          onClick={() => setVisible(value => !value)}
          className="absolute inset-y-0 right-1 flex min-w-11 items-center justify-center rounded-lg text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      {error && <p id={`${id}-error`} role="alert" className="mt-1.5 text-sm text-error">{error}</p>}
    </div>
  );
}
