export default function EmptyState({ title, description }) {
  return (
    <div className="grid min-h-56 place-items-center px-6 py-10 text-center">
      <div className="max-w-sm">
        <h2 className="text-lg font-semibold tracking-tight text-ink">
          {title}
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted">{description}</p>
      </div>
    </div>
  );
}
