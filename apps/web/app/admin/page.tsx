import type { Metadata } from "next";
import { ConsoleLinks } from "../../components/admin/console-links";

export const metadata: Metadata = { title: "Administration · Kobe" };

export default function AdminHome() {
  return (
    <main>
      <h1>Administration</h1>
      <ConsoleLinks />
      <p>
        The install console is for the install Owner and Admins; the team console is for team admins
        of your active team. <a href="/">Back to Kobe</a>
      </p>
    </main>
  );
}
