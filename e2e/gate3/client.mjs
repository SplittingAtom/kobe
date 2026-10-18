// Gate 3 (KOBE-3, Product) harness, client side. e2e/gate3.sh runs this inside a Kobe server pod
// (`node --input-type=module -e`) after the Gate 1 client's helpers and the Gate 2 client's
// helpers (everything above `const MODES` in e2e/gate1/client.mjs and e2e/gate2/client.mjs:
// config, client(), readEvents(), db(), userClient(), ownerClient(), follow(), ...). It adds the
// Gate 3 steps and its own MODES; every step prints `key=value` lines for gate3.sh to assert on.
// It drives the product's API as the browser does; the database is only read, for evidence the
// API does not expose (the skills a run.start handed the sandbox, a file's object key).

/**
 * What the model said and the tools returned, cut here. Large: the `system?` echo carries Pi's
 * whole system prompt, and the agent's own prompt (and the skills list) come after Pi's ~2 KB.
 */
const PROMPT_OUT_MAX = 64_000;
const code = (r) => `${r.status}:${r.json.code ?? "-"}`;
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ");
/**
 * Signs config's user in from an address of its own each time: sign-in is limited to 3 per 10 s
 * per address, and the steps sign in once each (the server trusts X-Forwarded-For from pods).
 */
const signedInAs = (user) =>
  userClient({ ...user, ip: `198.51.102.${1 + Math.floor(Math.random() * 250)}` });

/** Every entry id of a thread, all pages (the first GET returns one page). */
async function allEntries(c, threadId) {
  const ids = [];
  let after;
  for (let page = 0; page < 50; page += 1) {
    const r = await c.call(
      "GET",
      `/v1/threads/${threadId}${after === undefined ? "" : `?after=${after}`}`,
    );
    if (r.status !== 200) return { status: r.status, ids, json: r.json };
    ids.push(...(r.json.entries ?? []).map((e) => e.entry_id));
    if (r.json.next_entries_after == null) return { status: 200, ids, json: r.json };
    after = r.json.next_entries_after;
  }
  return { status: 200, ids, json: {} };
}

// --- one turn of a conversation, with its approvals ----------------------------------------------

/** Lists the project's memory docs and says whether `path` is among them. */
async function projectDocPresent(c, projectId, path) {
  const res = await c.call("GET", `/v1/memory?scope=project&project_id=${projectId}`);
  return res.status === 200 && res.text.includes(`"path":"${path}"`) ? "present" : "absent";
}

/**
 * Answers the run's pending approvals once a second. `config.hold` names a tool whose approval is
 * inspected first (for `remember`: is the project doc there before the decision?) and decided
 * with `config.holdDecision` (allow or deny); every other approval is allowed unless
 * `config.approve` is "none".
 */
function startApprover(c, runId) {
  const decided = new Set();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const list = await c.call("GET", `/v1/approvals?status=pending&run_id=${runId}`);
      for (const a of list.json.approvals ?? []) {
        if (decided.has(a.approval_id)) continue;
        decided.add(a.approval_id);
        const held = config.hold !== undefined && a.tool === config.hold;
        if (held && config.holdProject) {
          const doc = await projectDocPresent(c, config.holdProject, config.holdPath);
          out("held", `${a.tool}:doc_before_decision=${doc}`);
        }
        if (!held && config.approve === "none") continue;
        const decision = held ? (config.holdDecision ?? "allow") : "allow";
        const r = await c.call("POST", `/v1/approvals/${a.approval_id}`, { decision });
        out("decided", `${a.tool}:${decision}:${r.status}`);
      }
    } catch (err) {
      out("approver_error", oneLine(err).slice(0, 200));
    } finally {
      busy = false;
    }
  }, 1000);
  return () => clearInterval(timer);
}

/** The evidence of one run's event log, as key=value lines. */
function reportEvents(events, terminal) {
  const of = (type) => events.filter((e) => e.type === type).map((e) => e.data.payload ?? {});
  const started = of("run.started")[0];
  out("terminal", terminal?.type ?? "none");
  out("error", terminal?.data.payload?.error?.code ?? "-");
  out("error_message", oneLine(terminal?.data.payload?.error?.message ?? "-").slice(0, 300));
  out(
    "waking",
    of("sandbox.waking")
      .map((p) => p.reason ?? "?")
      .join(",") || "-",
  );
  out(
    "started_agent",
    started ? `${started.agent_id ?? "-"}:${started.agent_version ?? "-"}` : "-",
  );
  out(
    "omitted",
    of("context.omitted")
      .flatMap((p) => p.items ?? [])
      .map((i) => `${i.kind}:${i.name}:${i.reason}`)
      .join(",") || "-",
  );
  out(
    "approvals_requested",
    of("approval.requested")
      .map((p) => p.tool)
      .join(",") || "-",
  );
  out(
    "artifact_events",
    events
      .filter((e) => e.type === "artifact.created" || e.type === "artifact.updated")
      .map((e) => `${e.type}:${e.data.payload?.artifact_id}:v${e.data.payload?.version ?? "?"}`)
      .join(",") || "-",
  );
  out(
    "file_events",
    of("file.shared")
      .map((p) => `${p.file_id}:${p.name}:${p.size}`)
      .join(",") || "-",
  );
  out(
    "memory_events",
    of("memory.updated")
      .map(
        (p) =>
          `${p.scope}:${p.memory_doc_id}:${p.path}:v${p.version}:${p.previous_version ?? "none"}`,
      )
      .join(",") || "-",
  );
  out(
    "text",
    oneLine(
      of("text.delta")
        .map((p) => p.delta ?? "")
        .join(""),
    ).slice(0, PROMPT_OUT_MAX),
  );
  out(
    "tool_output",
    oneLine(
      of("tool.result")
        .map((p) => JSON.stringify(p))
        .join(" "),
    ).slice(0, PROMPT_OUT_MAX),
  );
}

/** One message from config.user: in config.threadId, or in a new thread (agent, project). */
async function turn() {
  const c = await signedInAs(config.user);
  let threadId = config.threadId;
  if (!threadId) {
    const made = await c.call("POST", "/v1/threads", {
      title: config.title ?? "gate3",
      ...(config.agentId ? { agent_id: config.agentId } : {}),
      ...(config.projectId ? { project_id: config.projectId } : {}),
    });
    out("thread_status", code(made));
    out("thread_agent_version", made.json.agent_version ?? "-");
    threadId = made.json.thread_id;
  }
  out("thread", threadId ?? "-");
  if (!threadId) return;
  const sent = await c.call("POST", `/v1/threads/${threadId}/messages`, {
    content: config.content,
    ...(config.fileIds ? { file_ids: config.fileIds } : {}),
  });
  out("message", code(sent));
  const runId = sent.json.run_id;
  out("run", runId ?? "-");
  if (sent.status !== 201 || !runId) return;
  const stop = startApprover(c, runId);
  let seen;
  try {
    seen = await follow(c, runId, config.timeoutMs ?? 300_000);
  } finally {
    stop();
  }
  reportEvents(seen.events, seen.terminal);
}

// --- agents and versions (ac-1) ---------------------------------------------------------------------

const ANY = { "if-match": "*" };

async function agent() {
  const c = await signedInAs(config.user);
  const id = config.agentId;
  const definition = { frontmatter: config.frontmatter, prompt: config.prompt };
  switch (config.action) {
    case "create": {
      const r = await c.call("POST", "/v1/agents", { scope: "team", ...definition });
      out("agent_create", code(r));
      out("agent_id", r.json.agent?.id ?? "-");
      return;
    }
    case "edit":
      out("agent_edit", code(await c.call("PUT", `/v1/agents/${id}`, definition, ANY)));
      return;
    case "publish": {
      const r = await c.call("POST", `/v1/agents/${id}/publish`, undefined, ANY);
      out("publish", code(r));
      out("version", r.json.version?.version ?? "-");
      return;
    }
    case "rollback": {
      const r = await c.call("POST", `/v1/agents/${id}/rollback`, { version: config.version });
      out("rollback", code(r));
      out("version", r.json.version?.version ?? "-");
      out("republished_from", r.json.version?.republishedFrom ?? "-");
      out("prompt", oneLine(r.json.version?.prompt ?? "-").slice(0, 300));
      return;
    }
    case "versions": {
      const r = await c.call("GET", `/v1/agents/${id}/versions`);
      out("current_version", r.json.currentVersion ?? "-");
      out(
        "versions",
        (r.json.versions ?? [])
          .map((v) => `${v.version}:${v.republishedFrom ?? "-"}`)
          .sort()
          .join(","),
      );
      return;
    }
    default:
      throw new Error(`unknown agent action ${config.action}`);
  }
}

/** A thread as config.user sees it; optionally switches its agent version first (one click). */
async function thread() {
  const c = await signedInAs(config.user);
  if (config.switchTo !== undefined) {
    const body = config.switchTo === null ? {} : { version: config.switchTo };
    const s = await c.call("POST", `/v1/threads/${config.threadId}/agent-version`, body);
    out("switch", `${s.status}:${s.json.agent_version ?? s.json.code ?? "-"}`);
  }
  const r = await c.call("GET", `/v1/threads/${config.threadId}`);
  out("get", code(r));
  out("agent_pin", `${r.json.agent_version ?? "-"}:${r.json.agent_current_version ?? "-"}`);
  out("read_only", r.json.read_only ?? "-");
}

/** A team admin changes a member's role (the Builder of ac-1 and ac-2). */
async function role() {
  const admin = await signedInAs(config.admin);
  const r = await admin.call("PATCH", `/v1/team/members/${config.userId}`, { role: config.role });
  out("role", `${r.status}:${r.json.role ?? r.json.code ?? "-"}`);
}

// --- skills (ac-2) --------------------------------------------------------------------------------

/** A minimal zip of stored (uncompressed) regular files, the shape the skill reader accepts. */
async function storedZip(files) {
  const { crc32 } = await import("node:zlib");
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Uploads a skill whose script makes a network call (curl), as config.user, to config.scope. */
async function skillUpload() {
  const c = await signedInAs(config.user);
  const zip = await storedZip([
    [
      "SKILL.md",
      `---\nname: ${config.name}\ndescription: ${config.description}\n---\n\n` +
        "Fetches the latest figures. Run scripts/fetch.sh.\n",
    ],
    ["scripts/fetch.sh", `#!/bin/sh\ncurl -fsS ${config.url}\n`],
  ]);
  const r = await c.raw("POST", `/v1/skills?scope=${config.scope}`, zip, {
    "content-type": "application/zip",
  });
  out("skill_upload", code(r));
  out("skill_id", r.json.skill?.id ?? "-");
  out("skill_version", r.json.version?.version ?? "-");
  out("content_hash", r.json.version?.contentHash ?? "-");
  const review = r.json.version?.review;
  out("review", review ? `${review.status}:flagged=${review.flagged}` : "-");
}

/** The team admin's review queue entry for the skill, then (optionally) the decision. */
async function skillReview() {
  const admin = await signedInAs(config.admin);
  const list = await admin.call("GET", "/v1/team/skill-review?status=pending");
  out("review_list", list.status);
  const row = (list.json.reviews ?? []).find((r) => JSON.stringify(r).includes(config.skillId));
  out("review_row", row ? oneLine(JSON.stringify(row)).slice(0, 900) : "-");
  if (config.decision) {
    const r = await admin.call(
      "POST",
      `/v1/team/skill-review/${config.skillId}/versions/${config.version}`,
      {
        decision: config.decision,
        note: "Gate 3: reviewed the network call",
        // The admin read the findings listed above and accepts exactly those (KOBE-312).
        ...(row?.findingsDigest ? { acknowledgedFindings: row.findingsDigest } : {}),
      },
    );
    out("decision", `${r.status}:${r.json.review?.status ?? r.json.code ?? "-"}`);
  }
}

/** Adds (or removes) a bundle hash on the site's skill blocklist, as the Owner. */
async function blocklist() {
  const owner = await ownerClient();
  if (config.action === "remove") {
    out("unblock", (await owner.call("DELETE", `/v1/site/skill-blocklist/${config.hash}`)).status);
    return;
  }
  const r = await owner.call("POST", "/v1/site/skill-blocklist", {
    contentHash: config.hash,
    reason: "Gate 3: a blocklisted bundle never loads",
  });
  out("block", code(r));
}

/** The skill bundles the run's run.start handed the sandbox (what Pi was told to load). */
async function runBundles() {
  // The run.start command row itself is deleted once the sandbox answers (it carries content), so
  // the durable record is read: `runs.skill_refs` (KOBE-297), written in the run start's own
  // transaction from the same bundle list the run.start frame carries, and the run's
  // `run.started` event.
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  try {
    const rows = await withTeam(database.db, config.teamId, (tx) =>
      tx.execute(sql`
        SELECT r.skill_refs AS refs,
               (SELECT count(*)::int FROM run_events e
                 WHERE e.team_id = r.team_id AND e.run_id = r.id AND e.type = 'run.started') AS started
          FROM runs r
         WHERE r.team_id = ${config.teamId} AND r.id = ${config.runId}`),
    );
    const row = rows.rows[0];
    out("run_start", row ? Math.min(row.started, 1) : 0);
    const hashes = (row?.refs ?? []).flatMap((r) => (r.sha256 ? [r.sha256] : []));
    out("bundles", hashes.join(",") || "-");
  } finally {
    await database.close();
  }
}

// --- projects (ac-3) --------------------------------------------------------------------------------

async function projectSetup() {
  const admin = await signedInAs(config.admin);
  const made = await admin.call("POST", "/v1/projects", {
    name: config.name,
    instructions: "Gate 3 project",
    members_mode: "selected",
    member_user_ids: [],
  });
  out("project_create", `${made.status}:${made.json.my_role ?? made.json.code ?? "-"}`);
  out("project_id", made.json.id ?? "-");
  out("project_slug", made.json.slug ?? "-");
  if (!made.json.id) return;
  for (const userId of config.members) {
    const added = await admin.call("POST", `/v1/projects/${made.json.id}/members`, {
      user_id: userId,
      role: "member",
    });
    out("member_added", added.status);
  }
  const form = new FormData();
  form.append("path", "docs");
  form.append("file", new Blob([config.fileText], { type: "text/plain" }), "brief.txt");
  const up = await admin.raw("POST", `/v1/projects/${made.json.id}/files`, form);
  out("project_file", `${up.status}:${up.json.path ?? up.json.code ?? "-"}`);
}

/** A project thread is private until shared; shared, it is readable and forkable, not writable. */
async function projectShare() {
  const author = await signedInAs(config.author);
  const other = await signedInAs(config.other);
  const t = config.threadId;
  const listed = async () =>
    (
      (await other.call("GET", `/v1/threads?project_id=${config.projectId}`)).json.threads ?? []
    ).some((x) => x.thread_id === t);
  out("other_before", code(await other.call("GET", `/v1/threads/${t}`)));
  out("other_listed_before", await listed());
  const shared = await author.call("POST", `/v1/threads/${t}/share`, { visibility: "project" });
  out("share", `${shared.status}:${shared.json.visibility ?? shared.json.code ?? "-"}`);
  const seen = await other.call("GET", `/v1/threads/${t}`);
  out("other_after", `${seen.status}:read_only=${seen.json.read_only}`);
  out("other_entries", (seen.json.entries ?? []).length);
  out("other_listed_after", await listed());
  out(
    "other_post",
    code(await other.call("POST", `/v1/threads/${t}/messages`, { content: "mine?" })),
  );
  out("other_rename", code(await other.call("PATCH", `/v1/threads/${t}`, { title: "mine" })));
  const fork = await other.call("POST", `/v1/threads/${t}/fork`, {});
  out("fork", code(fork));
  const mine = fork.json.thread_id
    ? await other.call("GET", `/v1/threads/${fork.json.thread_id}`)
    : { status: 0, json: {} };
  out(
    "fork_get",
    `${mine.status}:read_only=${mine.json.read_only}:${mine.json.visibility}:entries=${(mine.json.entries ?? []).length > 0}`,
  );
  if (fork.json.thread_id) {
    out("fork_from_author", code(await author.call("GET", `/v1/threads/${fork.json.thread_id}`)));
  }
  const unshared = await author.call("POST", `/v1/threads/${t}/share`, { visibility: "private" });
  out("unshare", `${unshared.status}:${unshared.json.visibility ?? "-"}`);
  out("other_after_unshare", code(await other.call("GET", `/v1/threads/${t}`)));
}

// --- memory (ac-4) ------------------------------------------------------------------------------------

async function memorySettings() {
  const admin = await signedInAs(config.admin);
  const r = await admin.call("PUT", "/v1/memory/settings?level=team", {
    memory_enabled: true,
    project_memory_enabled: true,
  });
  out("memory_settings", `${r.status}:${oneLine(r.text).slice(0, 200)}`);
}

/** A memory doc as its owner sees it; with config.restore, Undo (restore that version) first. */
async function memoryDoc() {
  const c = await signedInAs(config.user);
  if (config.restore !== undefined) {
    const r = await c.call("POST", `/v1/memory/${config.docId}/restore`, {
      version: config.restore,
    });
    out("restore", code(r));
  }
  const r = await c.call("GET", `/v1/memory/${config.docId}`);
  out("doc", code(r));
  out("doc_content", oneLine(r.json.content ?? "-").slice(0, 300));
  out("doc_version", r.json.current_version ?? "-");
}

async function memoryProject() {
  const c = await signedInAs(config.user);
  for (const path of config.paths) {
    out(`project_doc ${path}`, await projectDocPresent(c, config.projectId, path));
  }
}

// --- uploads, artifacts and a lost sandbox (ac-5) ---------------------------------------------------

async function galleryAgent() {
  const database = await db();
  try {
    const rows = await database.pool.query(
      "SELECT id FROM site_agents WHERE scope = 'gallery' AND gallery_key = $1 AND archived_at IS NULL",
      [config.key],
    );
    out("gallery_agent", rows.rows[0]?.id ?? "-");
  } finally {
    await database.close();
  }
}

/** The object behind a files row: its key and whether the object store holds it (and its size). */
async function objectOf(teamId, fileId) {
  const database = await db();
  const { withTeam, sql } = await import("/app/node_modules/@kobe/db/dist/index.js");
  let key;
  try {
    const rows = await withTeam(database.db, teamId, (tx) =>
      tx.execute(sql`SELECT blob_ref FROM files WHERE team_id = ${teamId} AND id = ${fileId}`),
    );
    key = rows.rows[0]?.blob_ref;
  } finally {
    await database.close();
  }
  if (!key) return { key: "-", state: "no_row" };
  const { loadS3Settings, createS3ObjectStore } = await import("/app/dist/workspace-sync/index.js");
  const settings = loadS3Settings(process.env);
  if (!settings) return { key, state: "no_object_storage" };
  const got = await createS3ObjectStore(settings).get(key);
  if (!got) return { key, state: "missing" };
  got.body.destroy();
  return { key, state: `present:${got.size}` };
}

async function upload() {
  const c = await signedInAs(config.user);
  const form = new FormData();
  form.append("thread_id", config.threadId);
  form.append("file", new File([config.text], config.name, { type: "text/csv" }));
  const r = await c.raw("POST", "/v1/uploads", form);
  out("upload", `${r.status}:${r.json.size_bytes ?? r.json.code ?? "-"}:${r.json.name ?? "-"}`);
  out("file_id", r.json.file_id ?? "-");
  if (!r.json.file_id) return;
  const obj = await objectOf(config.user.teamId, r.json.file_id);
  out("object_key", obj.key);
  out("object", obj.state);
}

async function sha256(text) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

/** The artifact's frame (headers) and content as config.user's browser would fetch them. */
async function artifact() {
  const c = await signedInAs(config.user);
  const id = config.artifactId;
  const detail = await c.call("GET", `/v1/artifacts/${id}`);
  out("artifact", code(detail));
  const frame = await c.raw(
    "GET",
    `/v1/artifacts/${id}/versions/${config.version}/frame?team=${config.user.teamId}`,
  );
  out("frame", frame.status);
  out("frame_csp", frame.headers.get("content-security-policy") ?? "-");
  out("frame_xfo", frame.headers.get("x-frame-options") ?? "-");
  out("frame_type", frame.headers.get("content-type") ?? "-");
  out("frame_body_has_script", frame.text.includes("<script>"));
}

/** What must survive the sandbox's loss: entries, artifacts, shared files, uploads (U15). */
async function state() {
  const c = await signedInAs(config.user);
  const t = config.threadId;
  const entries = await allEntries(c, t);
  out("thread_get", entries.status);
  out("entries", entries.ids.join(",") || "-");
  const arts = await c.call("GET", `/v1/artifacts?thread_id=${t}`);
  out(
    "artifacts",
    (arts.json.artifacts ?? [])
      .map((a) => a.id)
      .sort()
      .join(",") || "-",
  );
  for (const a of config.artifacts ?? []) {
    const body = await c.call("GET", `/v1/artifacts/${a}/versions/1/content`);
    out(`artifact_content ${a}`, `${body.status}:${await sha256(body.text)}`);
  }
  for (const f of config.files ?? []) {
    const body = await c.call("GET", `/v1/files/${f}/content`);
    out(`file_content ${f}`, `${body.status}:${await sha256(body.text)}`);
  }
  for (const f of config.uploads ?? []) {
    out(`upload_object ${f}`, (await objectOf(config.user.teamId, f)).state);
  }
}

const MODES = {
  fixtures,
  turn,
  agent,
  thread,
  role,
  "skill-upload": skillUpload,
  "skill-review": skillReview,
  blocklist,
  "run-bundles": runBundles,
  "project-setup": projectSetup,
  "project-share": projectShare,
  "memory-settings": memorySettings,
  "memory-doc": memoryDoc,
  "memory-project": memoryProject,
  "gallery-agent": galleryAgent,
  upload,
  artifact,
  state,
};

const runStep = MODES[config.mode];
if (!runStep) {
  console.error(`unknown mode ${config.mode}`);
  process.exit(2);
}
try {
  await runStep();
  setTimeout(() => process.exit(0), 200).unref();
} catch (err) {
  console.error(`gate3 ${config.mode} failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
