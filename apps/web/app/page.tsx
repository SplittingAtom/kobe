/**
 * The chat (KOBE-32). The root layout renders it (components/shell/workspace-host.tsx, KOBE-452),
 * so it stays mounted while the consoles and the My area open as panels over it: this page adds
 * nothing of its own. Client-rendered: every request carries this browser's session cookie.
 */
export default function Home() {
  return null;
}
