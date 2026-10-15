"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

/**
 * The two places the chat shell keeps a text link (CE13, KOBE-203); the lint rule against bare
 * text links (`eslint.config.js`) lets these through and nothing else. Navigation and actions are
 * `IconAction`s; don't reach for these to label a control.
 */

interface TextLinkProps {
  readonly href: string;
  /** A file download: a plain link the router leaves alone. */
  readonly download?: boolean | undefined;
  /** In-app navigation without a page load (call `preventDefault`), e.g. opening a thread. */
  readonly onClick?: ((e: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  readonly children: ReactNode;
}

function TextLink({ href, download, onClick, children }: TextLinkProps) {
  return download ? (
    <a href={href} download onClick={onClick}>
      {children}
    </a>
  ) : (
    <Link href={href} {...(onClick ? { onClick } : {})}>
      {children}
    </Link>
  );
}

/** Prose only: a link inside a sentence ("Export your conversations to keep a copy"). */
export function InlineLink(props: TextLinkProps) {
  return <TextLink {...props} />;
}

/** An item of a bar disclosure menu (the profile menu): a menu lists names, which are text. */
export function MenuLink(props: TextLinkProps) {
  return <TextLink {...props} />;
}
