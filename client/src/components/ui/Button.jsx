export default function Button({
  className = "",
  variant = "primary",
  type = "button",
  ...props
}) {
  const variants = {
    // Penpot has no hover/disabled state for buttons; these are opacity-derived
    // from bg-brand pending a design answer for the real hover/disabled colours.
    primary: "bg-brand text-surface hover:bg-brand/90 disabled:bg-brand/40",
    secondary: "border border-line bg-surface text-ink hover:bg-canvas",
    ghost: "text-muted hover:bg-canvas hover:text-ink",
  };
  return (
    <button
      type={type}
      className={`inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
      {...props}
    />
  );
}
