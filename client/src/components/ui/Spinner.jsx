import logo from "@/assets/brand/logo.svg";
export default function Spinner({ fullPage = false, label = "Loading" }) {
  return (
    <div
      className={`conclave-loading flex flex-col items-center justify-center gap-5 ${fullPage ? "min-h-screen" : "min-h-40"}`}
      role="status"
      aria-live="polite"
    >
      <div className="conclave-loading-mark" aria-hidden="true">
        <span className="conclave-loading-halo" />
        <span className="conclave-loading-halo conclave-loading-halo-delayed" />
        <img src={logo} alt="" width="56" height="56" />
        <span className="conclave-loading-spark" />
      </div>
      <div className="flex flex-col items-center gap-3">
        <span className="text-label text-muted">{label}</span>
        <span className="conclave-loading-track" aria-hidden="true">
          <span />
        </span>
      </div>
    </div>
  );
}
