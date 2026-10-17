/**
 * Domain fronting (KOBE-38): the proxy sees only the TLS server name. Shown after a domain in the
 * Site console's egress ceiling and the Team console's egress list.
 */
export function SharedHostingNote() {
  return (
    <span className="text-sm font-normal text-console-muted">
      {" "}
      Shared hosting or CDN: a sandbox allowed here may also reach other sites behind the same front
      (domain fronting).
    </span>
  );
}
