import Room from "./Room";
import { useParams } from "react-router-dom";

export default function ConversationRoute() {
  const { roomId } = useParams();
  return <Room key={roomId} />;
}
