"use client";

import { useState } from "react";
import { folderPath, newFolderProblem } from "../../lib/skills/paths";
import { Button, Field, TextInput } from "../ui/console";

/**
 * New folder (KOBE-478): a folder name (nested with /) checked with the package path rules. A
 * draft stores files only, each with its folder in its path, so the folder is shown in the tree
 * until a file is saved in it; nothing is written for it.
 */
export function NewFolder({
  paths,
  folders,
  onAdd,
}: {
  readonly paths: readonly string[];
  /** The empty folders shown so far. */
  readonly folders: readonly string[];
  readonly onAdd: (folder: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setName("");
    setProblem(null);
  };
  if (!open)
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        New folder
      </Button>
    );
  return (
    <form
      noValidate
      aria-label="New folder"
      className="grid w-full gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const why = newFolderProblem(name, paths, folders);
        setProblem(why);
        if (why) return;
        onAdd(folderPath(name));
        close();
      }}
    >
      <Field
        label="Folder name"
        hint="For example templates or references/forms"
        error={problem ?? undefined}
      >
        <TextInput
          type="text"
          className="w-full"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Add folder
        </Button>
        <Button type="button" size="sm" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
