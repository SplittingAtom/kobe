/**
 * The last "Save skill to Workbench" of this tab (KOBE-322, coordinator): the chat stays open and
 * shows a link to the draft, until the member closes it or saves another. A tiny external store
 * (immutable snapshots) so the thread menu writes it and the chat's banner reads it.
 */
export interface SavedSkill {
  readonly draftId: string;
  readonly name: string;
  /** Saving again from the same conversation updated an existing draft. */
  readonly updated: boolean;
}

let current: SavedSkill | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function showSavedSkill(saved: SavedSkill): void {
  current = { ...saved };
  emit();
}

export function clearSavedSkill(): void {
  current = null;
  emit();
}

export const savedSkill = (): SavedSkill | null => current;

export function subscribeSavedSkill(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
