"use client";

import type { KeptFile } from "../../../../lib/admin/skills/bundle";
import type { DraftFile } from "../../../../lib/admin/skills/validate";
import { Button, Field, Section, Textarea, TextInput } from "../../../ui/console";

/** The extra text files of a skill (editable) and its binary files (kept as is, read-only). */
export function FilesEditor({
  files,
  kept,
  errors,
  onChange,
}: {
  readonly files: readonly DraftFile[];
  readonly kept: readonly KeptFile[];
  readonly errors: Readonly<Record<number, string>> | undefined;
  readonly onChange: (files: readonly DraftFile[]) => void;
}) {
  const update = (key: number, patch: Partial<DraftFile>) =>
    onChange(files.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  const add = () =>
    onChange([...files, { key: Math.max(0, ...files.map((f) => f.key)) + 1, path: "", text: "" }]);
  return (
    <Section
      id="skill-files-heading"
      title="Files"
      description="Extra text files saved next to SKILL.md, such as references or scripts. Files are not executable: run scripts through an interpreter (bash script.sh, python script.py)."
    >
      {files.map((file, i) => (
        <fieldset
          key={file.key}
          className="my-4 box-border grid min-w-0 gap-3 rounded-lg border border-console-border px-4 py-3"
        >
          <legend className="px-1 font-semibold">File {i + 1}</legend>
          <Field label={`Path of file ${i + 1}`} error={errors?.[file.key]}>
            <TextInput
              type="text"
              className="w-full"
              value={file.path}
              onChange={(e) => update(file.key, { path: e.target.value })}
            />
          </Field>
          <Field label={`Contents of file ${i + 1}`}>
            <Textarea
              className="min-h-32 w-full resize-y font-mono"
              value={file.text}
              onChange={(e) => update(file.key, { text: e.target.value })}
            />
          </Field>
          <div>
            <Button
              size="sm"
              variant="danger"
              onClick={() => onChange(files.filter((f) => f.key !== file.key))}
            >
              Remove file {i + 1}
            </Button>
          </div>
        </fieldset>
      ))}
      <div className="my-4 flex flex-wrap items-center gap-2">
        <Button onClick={add}>Add file</Button>
      </div>
      {kept.length > 0 && (
        <Section
          level={3}
          title="Binary files, kept as is"
          description="These can't be edited here. They are carried unchanged into the new version."
        >
          <ul className="m-0 mb-4 ps-5">
            {kept.map((k) => (
              <li key={k.path}>
                {k.path} ({k.bytes.length.toLocaleString()} bytes)
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Section>
  );
}
