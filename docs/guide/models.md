---
title: Models and thinking levels
summary: How to choose the model and thinking level for a conversation, what the team default is, and what budgets and context limits mean for you.
section: Models
order: 1
audience: member
---

Kobe can use several AI models. Your team admins decide which ones your workspace may use; you
choose among them per conversation. This page covers picking a model, setting how much the model
thinks before it answers, and the limits you may run into.

## Pick a model

The model pill in the composer's toolbar (**Model for this conversation**) lists:

- **Team default (_model_)**: the model your team admins chose as the default;
- every other model your team enables.

The choice applies to this conversation and can be changed between messages; `/model <name>` does
the same from the keyboard. If the list says "No models are enabled for your team yet.", ask a team
admin. Some agents always use one model ("This agent always uses _model_."); then the picker is
fixed.

To compare models on the same question, use **Regenerate with…** on an answer: it asks again with
another model as a new version, which you can compare with **Compare versions**. See
[Sharing, forks and the conversation tree](chat/sharing-and-branches.md).

## Choose a thinking level

Many models can reason step by step before answering. The thinking pill (**Thinking level for this
conversation**) offers **Thinking off**, **Thinking low**, **Thinking medium** and **Thinking
high**, plus **Thinking: default** (the model's or agent's own default). `/thinking <level>` does
the same.

- Higher levels usually give better answers to hard questions, but take longer and cost more.
- Low or off is fine for quick lookups and simple edits.
- If a model has no thinking levels, the pill says "This conversation's model has no thinking
  levels to choose."

The model's reasoning appears as steps in the answer; **Show details** opens them.

## Limits you may meet

- **Context window.** Each model can read only so much at once. The gauge under the composer shows
  how full the conversation is; long threads are compacted automatically, or with **Compact now**.
  See [Writing messages](chat/composer.md).
- **Output limit.** A very long answer can stop with "The model hit its output limit here, so this
  reply is incomplete." Ask it to continue, or to write the result to a file.
- **Budgets.** Team admins can set daily or monthly spending budgets for the team, a default for
  each member and budgets for particular members; site admins can cap the whole site. When a
  budget runs out, the current step finishes and new model calls are refused until the next period
  or until an admin raises it. Admins are warned before that happens.

## Where models come from

Site admins connect model providers and build the site's model catalog (**Models and providers**
in the site console). Team admins enable models from that catalog for the team and pick the team
default (**Models** in the team console). Model calls go through Kobe's model gateway; the
sandbox never holds a provider key.

## Related

- [Team admin overview](admin/team-admin.md)
- [Glossary](glossary.md)
