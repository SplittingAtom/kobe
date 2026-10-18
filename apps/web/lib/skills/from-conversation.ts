/**
 * "Make a skill from this" (KOBE-322, spec SK10 start 2): a new conversation with the Kobe agent
 * (which carries skill-creator), with the source conversation attached as a Markdown file. An
 * attachment lands read-only in the new thread's `/workspace/uploads/<thread>/`, so the source
 * thread itself is never touched. The composer is prefilled with the request to skill-creator
 * (build the skill under `/workspace/skills/<name>/`) and the file attached, but nothing is sent:
 * the member reads it and sends it, so no model turn is spent unasked (coordinator, KOBE-322
 * review). Save to Workbench (the thread menu) then makes the result a draft.
 */
import type { ApiResult } from "../api/client";
import type { ChatApi } from "../chat/api";
import { conversationMarkdown } from "../chat/thread-copy";

export const KOBE_AGENT_KEY = "kobe";
export const SOURCE_FILE = "source-conversation.md";

export const skillPrompt = (title: string) =>
  [
    `Use the skill-creator skill to turn the conversation in the attached ${SOURCE_FILE} (“${title}”) into a reusable skill.`,
    "Take the steps, tools, corrections and formats from it, ask me only about the gaps,",
    "and build the skill under /workspace/skills/<name>/. When it is ready, tell me the folder name:",
    "I will save it to my Workbench from this conversation's menu.",
  ].join(" ");

const failed = (message: string): ApiResult<never> => ({
  ok: false,
  error: { status: 0, code: "client_error", message },
});

export interface FromConversationDeps {
  readonly api: ChatApi;
  /** Attaches a file to the thread's composer draft (it uploads at once, as a picked file). */
  readonly attach: (threadId: string, file: File) => void;
  /** Puts text in the thread's composer, for when it opens. */
  readonly prefill: (threadId: string, text: string) => void;
}

/** Makes the Workbench conversation, its composer ready to send; the new thread's id. */
export async function startSkillFromConversation(
  deps: FromConversationDeps,
  source: { readonly threadId: string; readonly title: string },
): Promise<ApiResult<{ readonly threadId: string }>> {
  const { api } = deps;
  const copied = await conversationMarkdown(api, source.threadId, source.title);
  if (!copied.ok) return copied;
  const agents = await api.runnableAgents();
  if (!agents.ok) return agents;
  const kobe = agents.data.find((a) => a.galleryKey === KOBE_AGENT_KEY);
  if (!kobe)
    return failed("The Kobe agent isn't available in this team, so skill-creator can't run.");
  const thread = await api.createThread(`Skill from: ${source.title}`.slice(0, 200), null, {
    agentId: kobe.id,
    test: false,
  });
  if (!thread.ok) return thread;
  const threadId = thread.data.threadId;
  const file = new File([copied.data.markdown], SOURCE_FILE, { type: "text/markdown" });
  deps.attach(threadId, file);
  deps.prefill(threadId, skillPrompt(source.title));
  return { ok: true, status: 201, data: { threadId } };
}
