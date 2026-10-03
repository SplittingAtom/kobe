import { ChatApp } from "../components/chat/chat-app";
import "./chat-global.css";

/** The chat (KOBE-32). Client-rendered: every request carries this browser's session cookie. */
export default function Home() {
  return <ChatApp />;
}
