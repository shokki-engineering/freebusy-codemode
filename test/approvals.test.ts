// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serveApprovals } from "../src/approvals.ts";
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
  assert.deepEqual(done.structuredContent, {
    status: "completed",
    executionId: paused.executionId,
    result: [...club.reservations.keys()][0],
  });
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
});
