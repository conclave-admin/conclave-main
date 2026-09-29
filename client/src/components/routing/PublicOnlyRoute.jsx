import { Navigate, Outlet } from "react-router-dom";
import { isDevAuthBypass } from "../../config/devPreview";
import { useAuth } from "../../contexts/AuthContext";
import Spinner from "../ui/Spinner";
export default function PublicOnlyRoute() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <Spinner fullPage label="Loading" />;
  if (isDevAuthBypass) return <Outlet />;
  return isAuthenticated ? <Navigate to="/" replace /> : <Outlet />;
}
