/**
 * "Make a skill from this" (KOBE-322, spec SK10 start 2): a new conversation with the Kobe agent
 * (which carries skill-creator), with the source conversation attached as a Markdown file. An
 * attachment lands read-only in the new thread's `/workspace/uploads/<thread>/`, so the source
 * thread itself is never touched. The first message asks skill-creator to build the skill under
 * `/workspace/skills/<name>/`; Save to Workbench (the thread menu) then makes it a draft.
 */
import type { ApiResult } from "../api/client";
import type { ChatApi } from "../chat/api";
import { conversationMarkdown } from "../chat/thread-copy";
import type { UploadTransport } from "../chat/uploads";

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
  readonly teamId: string;
  readonly upload: UploadTransport;
  readonly newKey: () => string;
}

/** Starts the Workbench conversation; its id once the first message is sent. */
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
  const uploaded = await deps.upload({
    teamId: deps.teamId,
    file,
    threadId,
    onProgress: () => undefined,
    signal: new AbortController().signal,
  });
  if (!uploaded.ok) return failed(uploaded.error.message);
  const sent = await api.sendMessage(
    threadId,
    { content: skillPrompt(source.title), fileIds: [uploaded.file.fileId] },
    deps.newKey(),
  );
  if (!sent.ok) return sent;
  return { ok: true, status: 201, data: { threadId } };
}
