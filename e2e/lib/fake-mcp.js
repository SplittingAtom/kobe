const http = require("http");
http
  .createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = JSON.parse(body);
      if (req.headers.authorization) console.log("AUTH-HEADER-PRESENT");
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
            capabilities: { tools: {} },
            serverInfo: { name: "e2e-fake", version: "1" },
          },
        });
      } else if (m.method === "tools/call") {
        console.log("CALL " + m.params.name + " " + JSON.stringify(m.params.arguments));
        reply({ result: { content: [{ type: "text", text: "fake:" + m.params.name }] } });
      } else {
        reply({ error: { code: -32601, message: "not here" } });
      }
    });
  })
  .listen(8080);
