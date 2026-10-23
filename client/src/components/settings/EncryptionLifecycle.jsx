import { useEffect } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { isDevAuthBypass } from "../../config/devPreview";
import { lockEncryption } from "../../lib/encryption";
export default function EncryptionLifecycle() {
  const { user } = useAuth();
  useEffect(() => {
    lockEncryption();
    if (user?.id && !isDevAuthBypass)
      import("../../lib/encryption")
        .then((module) => module.initializeEncryption())
        .catch(() => {});
    return lockEncryption;
  }, [user?.id]);
  useEffect(() => {
    window.addEventListener("conclave:sync-stop", lockEncryption);
    window.addEventListener("conclave:session-ended", lockEncryption);
    return () => {
      lockEncryption();
      window.removeEventListener("conclave:sync-stop", lockEncryption);
      window.removeEventListener("conclave:session-ended", lockEncryption);
    };
  }, []);
  return null;
}
