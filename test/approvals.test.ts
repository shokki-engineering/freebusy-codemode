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
  });
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

  const forged = await post("/approve", { executionId: paused.executionId }, "https://evil.example");
  assert.equal(forged.status, 403, "another site cannot approve");
  assert.equal(club.reservations.size, 0);

  assert.equal((await post("/approve", { executionId: paused.executionId })).status, 200);
  const done = await client.callTool({ name: "codemode_status", arguments: { executionId: paused.executionId } });
  assert.deepEqual(done.structuredContent, {
    status: "completed",
    executionId: paused.executionId,
    result: [...club.reservations.keys()][0],
  });
});
