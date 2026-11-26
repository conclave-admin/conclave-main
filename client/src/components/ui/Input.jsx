export default function Input({ label, error, id, ...props }) {
  return (
    <label className="block" htmlFor={id}>
      {label && (
        <span className="mb-2 block text-sm font-medium text-ink">{label}</span>
      )}
      <input
        id={id}
        className={`min-h-12 w-full rounded-xl border bg-canvas/60 px-3.5 text-sm text-ink outline-none transition-shadow placeholder:text-muted/70 focus:border-brand focus:ring-2 focus:ring-brand/15 ${error ? "border-error" : "border-line"}`}
        {...props}
      />
      {error && (
        <span className="mt-1.5 block text-sm text-error">{error}</span>
      )}
    </label>
  );
}
