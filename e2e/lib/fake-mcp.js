const http = require("http");

// A fake remote MCP server for the k3d e2e suite (e2e/run.sh, gate2.sh): `tools/call` answers
// `fake:<name>` and logs `CALL <name> <arguments>`. Its tools are pinned straight into Postgres by
// those suites, so it lists none by default.
//
// FAKE_MCP_APPS=1 (the Kobe Explorer Gate, e2e/gate-apps.sh, KOBE-441) makes it an MCP Apps
// server: `tools/list` offers an opening tool whose `_meta.ui` names the `ui://e2e/explorer`
// template (a default and an integer argument, so the gate can see what Pi sends), two read-only
// tools apps may call (one app-only) and a write tool; `resources/list` and `resources/read`
// serve the template, a small test app speaking the ext-apps protocol over postMessage. Markers
// the gate looks for: the text result says `e2e explorer:`, the structured result carries
// `e2e-structured-only`, the template `e2e-template-marker`. `GET /_drift` changes the template's
// bytes (a rug-pull), `GET /_calls` lists the calls received.
const APPS = process.env.FAKE_MCP_APPS === "1";
const URI = "ui://e2e/explorer";
const MIME = "text/html;profile=mcp-app";
let version = 1;
const calls = [];

const TREE = {
  c: ["c.n"],
  "c.n": ["c.n.t", "c.n.u"],
};

const TOOLS = [
  {
    name: "open_explorer",
    title: "E2E Explorer",
    description: "Opens the e2e explorer app.",
    inputSchema: {
      type: "object",
      properties: { depth: { type: "integer", minimum: 1, maximum: 9, default: 2 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: URI } },
  },
  {
    name: "list_items",
    description: "Lists the children of a catalog item.",
    inputSchema: {
      type: "object",
      properties: { parent: { type: "string", maxLength: 64 } },
      required: ["parent"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "describe_item",
    description: "Describes a table.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", maxLength: 64 } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_thing",
    description: "Creates a thing (a write).",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

// The test app: renders the tree from the tool result, expands nodes with list_items, selects a
// table with describe_item (a context chip), "Use in chat" (ui/message), and three probes the gate
// expects to fail (a fetch out, ui/open-link, the write tool).
const APP = () => `<!doctype html>
<html><head><meta charset="utf-8"><title>E2E Explorer</title>
<!-- e2e-template-marker v${version} -->
<style>body{font:14px system-ui;margin:8px}button{margin:2px}#log{white-space:pre-wrap;font-size:12px}</style>
</head><body>
<h1>E2E Explorer</h1>
<ul role="tree" aria-label="Catalog" id="tree"></ul>
<section aria-label="Details" id="details"></section>
<button type="button" id="use" hidden>Use in chat</button>
<div>
<button type="button" id="probe-fetch">Probe fetch</button>
<button type="button" id="probe-link">Probe open link</button>
<button type="button" id="probe-write">Probe write</button>
</div>
<p id="input" data-tool-input=""></p>
<p id="log" aria-live="polite"></p>
<script>
let next = 0;
const pending = new Map();
const host = window.parent;
function request(method, params) {
  return new Promise((resolve) => {
    const id = ++next;
    pending.set(id, resolve);
    host.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}
function notify(method, params) {
  host.postMessage({ jsonrpc: "2.0", method, params }, "*");
}
function log(key, value) {
  document.getElementById("log").textContent += key + "=" + value + "\\n";
  document.body.setAttribute("data-" + key, String(value));
}
function item(id, leaf) {
  const li = document.createElement("li");
  li.setAttribute("role", "treeitem");
  li.setAttribute("aria-expanded", "false");
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = id;
  b.addEventListener("click", () => (leaf ? select(id) : expand(id, li)));
  li.appendChild(b);
  return li;
}
async function expand(id, li) {
  const answer = await request("tools/call", { name: "list_items", arguments: { parent: id } });
  const children = answer.result?.structuredContent?.items ?? [];
  const ul = document.createElement("ul");
  ul.setAttribute("role", "group");
  for (const c of children) ul.appendChild(item(c.id, c.leaf));
  li.appendChild(ul);
  li.setAttribute("aria-expanded", "true");
  log("expanded", id);
}
let selected = "";
async function select(id) {
  const answer = await request("tools/call", { name: "describe_item", arguments: { id } });
  const columns = answer.result?.structuredContent?.columns ?? [];
  document.getElementById("details").textContent = id + ": " + columns.join(", ");
  selected = id;
  await request("ui/update-model-context", { structuredContent: { table: id, columns } });
  document.getElementById("use").hidden = false;
  log("selected", id);
}
document.getElementById("use").addEventListener("click", async () => {
  const answer = await request("ui/message", {
    role: "user",
    content: [{ type: "text", text: "Use table \`" + selected + "\`" }],
  });
  log("message", answer.error ? "error" : "ok");
});
document.getElementById("probe-fetch").addEventListener("click", async () => {
  try {
    await fetch("https://example.com/e2e-exfil", { mode: "no-cors" });
    log("probe-fetch", "allowed");
  } catch {
    log("probe-fetch", "blocked");
  }
});
document.getElementById("probe-link").addEventListener("click", async () => {
  const answer = await request("ui/open-link", { url: "https://example.com/" });
  log("probe-link", answer.error ? "denied:" + answer.error.code : "allowed");
});
document.getElementById("probe-write").addEventListener("click", async () => {
  const answer = await request("tools/call", { name: "create_thing", arguments: { title: "x" } });
  log("probe-write", answer.error || answer.result?.isError ? "denied" : "allowed");
});
window.addEventListener("message", (event) => {
  if (event.source !== host) return;
  const m = event.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.id !== undefined && pending.has(m.id) && m.method === undefined) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === "ui/notifications/tool-input") {
    document.getElementById("input").setAttribute("data-tool-input", JSON.stringify(m.params?.arguments ?? {}));
  } else if (m.method === "ui/notifications/tool-result") {
    const tree = document.getElementById("tree");
    tree.textContent = "";
    for (const root of m.params?.structuredContent?.roots ?? []) tree.appendChild(item(root, false));
    log("rendered", "true");
  } else if (m.method === "ui/resource-teardown") {
    host.postMessage({ jsonrpc: "2.0", id: m.id, result: {} }, "*");
  }
});
request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "e2e-explorer" } }).then(() =>
  notify("ui/notifications/initialized", {}),
);
</script>
</body></html>
`;

function callResult(name, args) {
  if (name === "open_explorer") {
    return {
      content: [
        {
          type: "text",
          text: `e2e explorer: catalog c (depth ${JSON.stringify(args.depth ?? null)})`,
        },
      ],
      structuredContent: { roots: ["c"], depth: args.depth ?? null, note: "e2e-structured-only" },
    };
  }
  if (name === "list_items") {
    const items = (TREE[args.parent] ?? []).map((id) => ({ id, leaf: !TREE[id] }));
    return {
      content: [{ type: "text", text: items.map((i) => i.id).join(", ") || "(none)" }],
      structuredContent: { items },
    };
  }
  if (name === "describe_item") {
    return {
      content: [{ type: "text", text: `${args.id}: id int, name text` }],
      structuredContent: { id: args.id, columns: ["id int", "name text"] },
    };
  }
  return { content: [{ type: "text", text: "fake:" + name }] };
}

http
  .createServer((req, res) => {
    if (req.method === "GET" && APPS && req.url === "/_drift") {
      version += 1;
      res.writeHead(200, { "content-type": "text/plain" }).end(`version=${version}\n`);
      return;
    }
    if (req.method === "GET" && req.url === "/_calls") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(calls));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = JSON.parse(body);
      if (req.headers.authorization) {
        console.log("AUTH-HEADER-PRESENT");
        // KOBE-303 e2e: which test-only credential arrived (the site key, never a session token).
        console.log("AUTH " + req.headers.authorization);
      }
      if (!("id" in m)) {
        res.writeHead(202).end();
        return;
      }
      const reply = (x) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...x }));
      };
      if (m.method === "initialize") {
        reply({
          result: {
            protocolVersion: m.params.protocolVersion,
            capabilities: APPS ? { tools: {}, resources: {} } : { tools: {} },
            serverInfo: { name: "e2e-fake", version: "1" },
          },
        });
      } else if (m.method === "tools/call") {
        const args = m.params.arguments ?? {};
        console.log("CALL " + m.params.name + " " + JSON.stringify(m.params.arguments));
        calls.push({ name: m.params.name, arguments: m.params.arguments ?? null });
        reply({
          result: APPS
            ? callResult(m.params.name, args)
            : { content: [{ type: "text", text: "fake:" + m.params.name }] },
        });
      } else if (APPS && m.method === "tools/list") {
        reply({ result: { tools: TOOLS } });
      } else if (APPS && m.method === "resources/list") {
        reply({ result: { resources: [{ uri: URI, name: "E2E Explorer", mimeType: MIME }] } });
      } else if (APPS && m.method === "resources/read" && m.params?.uri === URI) {
        console.log("READ " + URI + " v" + version);
        reply({ result: { contents: [{ uri: URI, mimeType: MIME, text: APP() }] } });
      } else {
        reply({ error: { code: -32601, message: "not here" } });
      }
    });
  })
  .listen(8080);
