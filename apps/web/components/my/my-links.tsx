import Link from "next/link";
import { MY_SECTIONS } from "../../lib/my/nav";

/** Links to the member's own pages, for the chat header. Needs no permission. */
export function MyLinks() {
  return (
    <nav aria-label="Your area">
      <ul>
        {MY_SECTIONS.map((s) => (
          <li key={s.id}>
            <Link href={s.href}>{s.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
