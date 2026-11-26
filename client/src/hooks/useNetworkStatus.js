import { useEffect, useState } from "react";
import { networkSnapshot } from "../lib/mediaPreferences";
export default function useNetworkStatus() {
  const [network, setNetwork] = useState(networkSnapshot);
  useEffect(() => {
    const connection =
      navigator.connection ||
      navigator.mozConnection ||
      navigator.webkitConnection;
    const update = () => setNetwork(networkSnapshot(connection));
    update();
    connection?.addEventListener?.("change", update);
    return () => connection?.removeEventListener?.("change", update);
  }, []);
  return network;
}
