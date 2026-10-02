import { ConsoleLinks } from "../components/admin/console-links";
import { TeamInvites } from "./team-invites";
import { TeamSwitcher } from "./team-switcher";

export default function Home() {
  return (
    <>
      <header>
        <TeamSwitcher />
        <ConsoleLinks />
      </header>
      <main>
        <h1>Kobe</h1>
        <TeamInvites />
      </main>
    </>
  );
}
