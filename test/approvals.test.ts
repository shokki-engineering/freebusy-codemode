// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { serveApprovals } from "../src/approvals.ts";
import { approverFromEnv, elicitationApprover, pageApprover } from "../src/approver.ts";
import { freebusyMcp } from "../src/runtime.ts";
import { evening, setup } from "./helpers.ts";

const { club, runtime } = setup();
const { server: page, port } = await serveApprovals(runtime, 47_911);
const taken = await serveApprovals(runtime, port);
after(() => {
  page.close();
  taken.server.close();
});

const book = `async () => {
  const hold = await holds.createHold({ hold: { window: ${JSON.stringify(evening)} } });
  return (await reservations.createReservation({ reservation: { hold: hold.name, customer: "users/ada" } })).name;
}`;

function post(path: string, body: Record<string, string>, origin = `http://127.0.0.1:${port}`) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

/** The pending calls the page shows, as approve form fields. */
async function shown(): Promise<{ executionId: string; seq: string }[]> {
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const forms = page.matchAll(
    /action="\/approve"><input type="hidden" name="executionId" value="([^"]+)"><input type="hidden" name="seq" value="(\d+)"/g,
  );
  return [...forms].map((m) => ({ executionId: m[1] ?? "", seq: m[2] ?? "" }));
}

test("a second server on a taken port falls back to a free one", () => {
  assert.notEqual(taken.port, port);
});

test("the model gets no approval tool; a person approves on the page", async () => {
  const client = new Client({ name: "desktop", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([freebusyMcp(runtime, port).connect(a), client.connect(b)]);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["code", "codemode_status"],
  );
  const paused = (await client.callTool({ name: "code", arguments: { code: book } })).structuredContent as {
    status: string;
    executionId: string;
    message: string;
  };
  assert.equal(paused.status, "paused");
  assert.ok(paused.message.includes(`127.0.0.1:${port}`));

  const listed = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(listed, /reservations\.createReservation/);

  const [call] = await shown();
  assert.ok(call);
  const forged = await post("/approve", call, "https://evil.example");
  assert.equal(forged.status, 403, "another site cannot approve");
  assert.equal(club.reservations.size, 0);

  const approved = await post("/approve", call);
  assert.equal(approved.status, 303, "redirects, so a reload cannot approve again");
  const done = await client.callTool({ name: "codemode_status", arguments: { executionId: paused.executionId } });
  const status = done.structuredContent as { status: string; result: string; approved: { path: string }[] };
  assert.equal(status.status, "completed");
  assert.equal(status.result, [...club.reservations.keys()][0]);
  assert.deepEqual(
    status.approved.map((c) => c.path),
    ["reservations.createReservation"],
    "Claude can tell which calls the person approved",
  );
});

test("one click approves one call: a parallel booking needs two", async () => {
  const before = club.reservations.size;
  const window = JSON.stringify({ startTime: "2026-12-01T21:00:00Z", endTime: "2026-12-01T22:00:00Z" });
  const out = await runtime.execute({
    code: `async () => {
      const [a, b] = await Promise.all([
        holds.createHold({ hold: { window: ${window} } }),
        holds.createHold({ hold: { window: ${window} } }),
      ]);
      return Promise.all([
        reservations.createReservation({ reservation: { hold: a.name, attributes: { group: "A" } } }),
        reservations.createReservation({ reservation: { hold: b.name, attributes: { group: "B" } } }),
      ]);
    }`,
  });
  assert.equal(out.status, "paused");
  const both = await shown();
  assert.equal(both.length, 2);

  await post("/approve", both[0] ?? { executionId: "", seq: "" });
  assert.equal(club.reservations.size, before + 1, "only the approved booking was made");
  assert.equal((await shown()).length, 1, "the other is still waiting");

  await post("/approve", (await shown())[0] ?? { executionId: "", seq: "" });
  assert.equal(club.reservations.size, before + 2);
  assert.equal((await shown()).length, 0);

  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.equal(
    page.match(/<td>approved<\/td>/g)?.length,
    3,
    "history lists every approval, this test's and the first's",
  );
  assert.match(page, /&quot;group&quot;:&quot;B&quot;/);

  const status = await runtime.getExecution(out.status === "paused" ? out.executionId : "");
  assert.equal(status?.approved.length, 2);
});

/** A client that answers every approval prompt with answer, recording the prompts. */
async function asking(answer: ElicitResult | (() => never)) {
  const prompts: { requestedSchema: unknown }[] = [];
  const client = new Client({ name: "elicits", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts.push(request.params as { requestedSchema: unknown });
    if (typeof answer === "function") answer();
    return answer as ElicitResult;
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([freebusyMcp(runtime, port).connect(a), client.connect(b)]);
  const run = async (code: string) =>
    (await client.callTool({ name: "code", arguments: { code } })).structuredContent as {
      status: string;
      executionId: string;
      error?: string;
    };
  return { run, prompts };
}

const lateBook = (hour: number) => `async () => {
  const window = { startTime: "2026-12-02T${hour}:00:00Z", endTime: "2026-12-02T${hour + 1}:00:00Z" };
  const hold = await holds.createHold({ hold: { window, candidateResources: ["resources/court-3"] } });
  return (await reservations.createReservation({ reservation: { hold: hold.name } })).name;
}`;

const heldCourt3 = (hour: number) =>
  [...club.holds.values()].filter((h) => h.window.startTime === `2026-12-02T${hour}:00:00Z`).map((h) => h.state);

test("the prompt is a required choice between Reject and Approve, with no default", async () => {
  const { run, prompts } = await asking({ action: "accept", content: { decision: "approve" } });
  const out = await run(lateBook(10));
  assert.equal(out.status, "completed", JSON.stringify(out));
  const schema = prompts[0]?.requestedSchema as {
    required: string[];
    properties: { decision: { default?: unknown; oneOf: { const: string }[] } };
  };
  assert.deepEqual(schema.required, ["decision"]);
  assert.equal(schema.properties.decision.default, undefined);
  assert.deepEqual(
    schema.properties.decision.oneOf.map((o) => o.const),
    ["reject", "approve"],
  );
});

test("choosing Reject ends the script, books nothing and releases the hold", async () => {
  const before = club.reservations.size;
  const { run } = await asking({ action: "accept", content: { decision: "reject" } });
  const out = await run(lateBook(11));
  assert.equal(out.status, "error");
  assert.match(out.error ?? "", /rejected reservations\.createReservation\. Rolled back: holds\.createHold\./);
  assert.equal(club.reservations.size, before);
  assert.deepEqual(heldCourt3(11), ["HOLD_STATE_RELEASED"]);
});

test("declining the prompt rejects the call", async () => {
  const before = club.reservations.size;
  const { run } = await asking({ action: "decline" });
  assert.equal((await run(lateBook(12))).status, "error");
  assert.equal(club.reservations.size, before);
});

test("accepting the prompt without choosing approves nothing: the call waits on the page", async () => {
  const before = club.reservations.size;
  for (const content of [{}, { approve: true }, { decision: "yes" }]) {
    const { run } = await asking({ action: "accept", content } as ElicitResult);
    const out = await run(lateBook(13));
    assert.equal(out.status, "paused", JSON.stringify({ content, out }));
    await runtime.reject({ executionId: out.executionId, seq: 2 });
  }
  assert.equal(club.reservations.size, before);
});

test("a prompt nobody answers in time leaves the call to the page", async () => {
  const client = new Client({ name: "away", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, () => new Promise<never>(() => undefined));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([freebusyMcp(runtime, port, (s) => elicitationApprover(s, 50)).connect(a), client.connect(b)]);
  const out = (await client.callTool({ name: "code", arguments: { code: lateBook(15) } })).structuredContent as {
    status: string;
    executionId: string;
  };
  assert.equal(out.status, "paused");
  await runtime.reject({ executionId: out.executionId, seq: 2 });
  assert.deepEqual(heldCourt3(15), ["HOLD_STATE_RELEASED"], "a reject on the page rolls back too");
});

test("FREEBUSY_APPROVAL=page never prompts: every call waits on the page", async () => {
  let prompted = 0;
  const client = new Client({ name: "page-only", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => {
    prompted += 1;
    return { action: "accept", content: { decision: "approve" } };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([freebusyMcp(runtime, port, approverFromEnv("page")).connect(a), client.connect(b)]);
  const out = (await client.callTool({ name: "code", arguments: { code: lateBook(16) } })).structuredContent as {
    status: string;
    executionId: string;
    message: string;
  };
  assert.equal(out.status, "paused");
  assert.ok(out.message.includes(`127.0.0.1:${port}`));
  assert.equal(prompted, 0, "the client was never asked");
  await runtime.reject({ executionId: out.executionId, seq: 2 });
  assert.equal(await pageApprover()({} as never), "defer");
  assert.throws(() => approverFromEnv("auto"), /must be "prompt" or "page"/);
});

test("a client that cannot show the prompt leaves the call to the page", async () => {
  const { run } = await asking(() => {
    throw new Error("cannot render");
  });
  const out = await run(lateBook(14));
  assert.equal(out.status, "paused");
  await runtime.reject({ executionId: out.executionId, seq: 2 });
});
