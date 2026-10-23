export default function Spinner({ fullPage = false, label = "Loading" }) {
  return (
    <div
      className={`flex items-center justify-center gap-3 text-sm text-muted ${fullPage ? "min-h-screen" : "min-h-32"}`}
      role="status"
    >
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-brand" />
      <span>{label}</span>
    </div>
  );
}
