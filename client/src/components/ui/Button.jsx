export default function Button({
  className = "",
  variant = "primary",
  type = "button",
  ...props
}) {
  const variants = {
    // Penpot has no hover/disabled state for buttons; these are opacity-derived
    // from bg-brand pending a design answer for the real hover/disabled colours.
    primary: "bg-brand text-white hover:bg-brand/90 disabled:bg-brand/40",
    secondary: "border border-line bg-surface text-ink hover:bg-canvas",
    ghost: "text-muted hover:bg-canvas hover:text-ink",
  };
  return (
    <button
      type={type}
      className={`inline-flex min-h-10 items-center justify-center rounded-xl px-4 text-sm font-semibold transition-[background-color,box-shadow,transform] active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${className}`}
      {...props}
    />
  );
}
