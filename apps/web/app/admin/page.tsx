import type { Metadata } from "next";
import { ConsoleLinks } from "../../components/admin/console-links";
import { ChatReturnLink } from "../../components/shell/chat-return-link";

export const metadata: Metadata = { title: "Administration · Kobe" };

export default function AdminHome() {
  return (
    <main>
      <h1>Administration</h1>
      <ConsoleLinks />
      <p>
        The site console is for the site Owner and Admins; the team console is for team admins of
        your active team. <ChatReturnLink>Back to Kobe</ChatReturnLink>
      </p>
    </main>
  );
}
