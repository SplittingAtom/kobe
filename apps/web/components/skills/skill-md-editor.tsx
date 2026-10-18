"use client";

import { useState } from "react";
import { descriptionMeter } from "../../lib/skills/meter";
import {
  composeSkillMd,
  otherFrontmatterProblem,
  splitSkillMd,
  type SkillMdParts,
} from "../../lib/skills/skill-md";
import { cn } from "../../lib/utils";
import { Button, Field, Notice, Textarea, TextInput } from "../ui/console";

/**
 * The description meter (SK12): its count, and a warning past 1,024 and again past 1,536. Only the
 * warning is announced (when it changes), not every keystroke's count.
 */
export function DescriptionMeter({
  description,
  id,
}: {
  readonly description: string;
  readonly id: string;
}) {
  const meter = descriptionMeter(description);
  return (
    <div id={id} data-level={meter.level} className="mt-1 text-sm">
      <p
        className={cn(
          "m-0",
          meter.level === "ok" ? "text-console-muted" : "font-medium text-console-danger",
        )}
      >
        {meter.length.toLocaleString("en-US")} / 1,024 characters
      </p>
      <p aria-live="polite" className="m-0 font-medium text-console-danger">
        {meter.message}
      </p>
    </div>
  );
}

/**
 * SKILL.md: a frontmatter form (name, description with its meter, other keys as YAML) and the
 * instructions; or the whole file as text, which is also what a SKILL.md the form can't read gets.
 */
export function SkillMdEditor({
  text,
  onChange,
}: {
  readonly text: string;
  readonly onChange: (text: string) => void;
}) {
  const parts = splitSkillMd(text);
  const [raw, setRaw] = useState(false);
  if (raw || !parts.ok)
    return (
      <>
        {!parts.ok && (
          <Notice tone="warn">
            <p>{parts.error} Fix it here; the form comes back once the frontmatter reads.</p>
          </Notice>
        )}
        <Field label="SKILL.md">
          <Textarea
            className="min-h-96 w-full resize-y font-mono"
            value={text}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
        {parts.ok && (
          <Button size="sm" className="mt-2" onClick={() => setRaw(false)}>
            Edit with the form
          </Button>
        )}
      </>
    );
  return <SkillMdForm parts={parts.value} onChange={onChange} onRaw={() => setRaw(true)} />;
}

function SkillMdForm({
  parts,
  onChange,
  onRaw,
}: {
  readonly parts: SkillMdParts;
  readonly onChange: (text: string) => void;
  readonly onRaw: () => void;
}) {
  const set = (patch: Partial<SkillMdParts>) => onChange(composeSkillMd({ ...parts, ...patch }));
  // Half-typed YAML stays in the field and out of SKILL.md until it reads as key: value lines.
  const [other, setOther] = useState(parts.other);
  const otherProblem = otherFrontmatterProblem(other);
  return (
    <div className="grid gap-4">
      <Field
        label="Name"
        hint="Lowercase letters, digits and hyphens. It names the skill everywhere."
      >
        <TextInput
          type="text"
          className="w-full"
          value={parts.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <div>
        <Field
          label="Description"
          hint="What the skill does, then when to use it: agents choose skills by it."
        >
          <Textarea
            rows={3}
            className="w-full resize-y"
            aria-describedby="skill-description-meter"
            value={parts.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
        <DescriptionMeter id="skill-description-meter" description={parts.description} />
      </div>
      <Field
        label="Other frontmatter (YAML)"
        hint="Optional keys, such as license: MIT. Nothing here pre-approves tools. The form rewrites the frontmatter (YAML comments go); edit SKILL.md as text to keep them."
        error={otherProblem ?? undefined}
      >
        <Textarea
          rows={3}
          className="w-full resize-y font-mono"
          value={other}
          onChange={(e) => {
            setOther(e.target.value);
            if (!otherFrontmatterProblem(e.target.value)) set({ other: e.target.value });
          }}
        />
      </Field>
      <Field label="Instructions (SKILL.md body)">
        <Textarea
          className="min-h-80 w-full resize-y font-mono"
          value={parts.body}
          onChange={(e) => set({ body: e.target.value })}
        />
      </Field>
      <div>
        <Button size="sm" onClick={onRaw}>
          Edit SKILL.md as text
        </Button>
      </div>
    </div>
  );
}
