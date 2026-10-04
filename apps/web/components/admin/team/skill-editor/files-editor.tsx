"use client";

import type { KeptFile } from "../../../../lib/admin/skills/bundle";
import type { DraftFile } from "../../../../lib/admin/skills/validate";
import adminStyles from "../../admin.module.css";
import agentStyles from "../agent-builder/agent-builder.module.css";
import { Field } from "../agent-builder/field";
import styles from "./skill-editor.module.css";

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
    <section aria-labelledby="skill-files-heading">
      <h2 id="skill-files-heading">Files</h2>
      <p className={adminStyles.hint}>
        Extra text files saved next to SKILL.md, such as references or scripts.
      </p>
      {files.map((file, i) => (
        <fieldset key={file.key} className={styles.fileCard}>
          <legend>File {i + 1}</legend>
          <Field
            label={`Path of file ${i + 1}`}
            errors={errors?.[file.key] ? [errors[file.key] as string] : undefined}
          >
            {(control) => (
              <input
                {...control}
                type="text"
                value={file.path}
                onChange={(e) => update(file.key, { path: e.target.value })}
              />
            )}
          </Field>
          <Field label={`Contents of file ${i + 1}`}>
            {(control) => (
              <textarea
                {...control}
                className={styles.fileText}
                value={file.text}
                onChange={(e) => update(file.key, { text: e.target.value })}
              />
            )}
          </Field>
          <div>
            <button type="button" onClick={() => onChange(files.filter((f) => f.key !== file.key))}>
              Remove file {i + 1}
            </button>
          </div>
        </fieldset>
      ))}
      <div className={agentStyles.toolbar}>
        <button type="button" onClick={add}>
          Add file
        </button>
      </div>
      {kept.length > 0 && (
        <>
          <h3>Binary files, kept as is</h3>
          <p className={adminStyles.hint}>
            These can&apos;t be edited here. They are carried unchanged into the new version.
          </p>
          <ul className={styles.kept}>
            {kept.map((k) => (
              <li key={k.path}>
                {k.path} ({k.bytes.length.toLocaleString()} bytes)
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
