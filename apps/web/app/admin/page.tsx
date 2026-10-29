import type { Metadata } from "next";
import { ConsoleLinks } from "../../components/admin/console-links";
import { AppName } from "../../components/shell/branding-context";
import { ChatReturnLink } from "../../components/shell/chat-return-link";

export const metadata: Metadata = { title: "Administration" };

export default function AdminHome() {
  return (
    // In its panel over the workspace (KOBE-452), whose heading names it: no h1 of its own.
    <main>
      <ConsoleLinks />
      <p>
        The site console is for the site Owner and Admins; the team console is for team admins of
        your active team.{" "}
        <ChatReturnLink>
          Back to <AppName />
        </ChatReturnLink>
      </p>
    </main>
  );
}
