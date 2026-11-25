const configuredHost = (import.meta.env?.VITE_OPERATOR_HOST || "admin.conclave.com.ng")
  .trim()
  .toLowerCase();

export const operatorHost = configuredHost;
export const isOperatorHost =
  typeof window !== "undefined" && window.location.hostname.toLowerCase() === configuredHost;

export function operatorUrl(path = "/") {
  const origin = import.meta.env?.VITE_OPERATOR_URL || `https://${configuredHost}`;
  return new URL(path, origin).toString();
}
