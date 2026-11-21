import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { invalidRequest, notFound, param, parseBody, readJson } from "./request.js";

const schema = z.strictObject({ name: z.string() });

/** A one-route app that answers what the helper made of the request. */
function appWith(handler: (c: Context) => Response | Promise<Response>) {
  const app = new Hono();
  app.post("/items/:id", handler);
  return app;
}

const send = (app: Hono, body: string | undefined, id = "x") =>
  app.request(`/items/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });

describe("readJson", () => {
  const app = appWith(async (c) => c.json({ body: (await readJson(c, "fallback")) ?? "nullish" }));

  it("gives the parsed body, whatever JSON value it is", async () => {
    expect(await (await send(app, '{"a":1}')).json()).toEqual({ body: { a: 1 } });
    expect(await (await send(app, "5")).json()).toEqual({ body: 5 });
    expect(await (await send(app, "[]")).json()).toEqual({ body: [] });
    expect(await (await send(app, "null")).json()).toEqual({ body: "nullish" });
  });

  it("gives the fallback for invalid or missing JSON", async () => {
    expect(await (await send(app, "{oops")).json()).toEqual({ body: "fallback" });
    expect(await (await send(app, undefined)).json()).toEqual({ body: "fallback" });
  });
});

describe("parseBody", () => {
  const app = appWith(async (c) => {
    const body = await parseBody(c, schema);
    return body ? c.json(body) : invalidRequest(c);
  });

  it("parses a body of the schema's shape", async () => {
    const res = await send(app, '{"name":"a"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "a" });
  });

  it.each([
    ["invalid JSON", "{oops"],
    ["the wrong type", '{"name":5}'],
    ["an array", "[]"],
    ["null", "null"],
    ["a number", "5"],
    ["a string", '"x"'],
    ["no body", undefined],
  ])("refuses %s with the default 400", async (_label, body) => {
    const res = await send(app, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: "invalid_request",
      message: "Check the request and try again.",
    });
  });
});

describe("param", () => {
  const app = appWith((c) => {
    const id = param(c, "id", z.uuid());
    return id.success ? c.json({ id: id.data }) : invalidRequest(c, "Bad id.");
  });

  it("parses a route parameter with the schema", async () => {
    const id = "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
    expect(await (await send(app, "{}", id)).json()).toEqual({ id });
  });

  it("reports a parameter the schema refuses", async () => {
    const res = await send(app, "{}", "nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "invalid_request", message: "Bad id." });
  });
});

describe("notFound", () => {
  it("answers 404 with the code and message", async () => {
    const app = appWith((c) => notFound(c, "thing_not_found", "No such thing."));
    const res = await send(app, "{}");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "thing_not_found", message: "No such thing." });
  });
});
