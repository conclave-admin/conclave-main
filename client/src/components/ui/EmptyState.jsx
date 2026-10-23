export default function EmptyState({ title, description }) {
  return (
    <div className="grid min-h-48 place-items-center px-6 text-center">
      <div>
        <h2 className="font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
    </div>
  );
}
