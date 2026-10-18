/**
 * One look for every icon action in the rail, links (Team console, Export my conversations) and
 * buttons alike: the outline button's border and background, the text colour (not the link
 * blue) and no browser padding. The shell loads no CSS reset, so without this a button kept the
 * browser's own box and a link had none. A pressed toggle (Threads, Files) shows the accent.
 */
export const RAIL_ACTION =
  "p-0 text-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground";

/** The variant every rail icon action uses with {@link RAIL_ACTION}. */
export const RAIL_ACTION_VARIANT = "outline" as const;
