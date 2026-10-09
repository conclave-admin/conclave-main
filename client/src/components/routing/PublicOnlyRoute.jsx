import { Navigate, Outlet } from "react-router-dom";
import { isDevAuthBypass } from "../../config/devPreview";
import { useAuth } from "../../contexts/AuthContext";
import Spinner from "../ui/Spinner";
export default function PublicOnlyRoute() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <Spinner fullPage label="Loading" />;
  if (isDevAuthBypass) return <Outlet />;
  // `/chats`, not `/`: `/` is the public landing page, so redirecting a
  // signed-in visitor there would only bounce them straight back here.
  return isAuthenticated ? <Navigate to="/chats" replace /> : <Outlet />;
}
