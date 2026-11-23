// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { completed, evening, setup } from "./helpers.ts";

const window = JSON.stringify(evening);

test("one script searches, holds and books; the booking waits for approval", async () => {
  const { club, runtime } = setup();
  const out = await runtime.execute({
    code: `async () => {
      const found = await availability.searchAvailability({ window: ${window}, resourceTypes: ["padel"] });
      const indoor = found.matches.filter((m) => m.resourceTypes.includes("indoor"));
      const hold = await holds.createHold({ hold: { window: ${window}, candidateResources: indoor.map((m) => m.resource) } });
      const r = await reservations.createReservation({ reservation: { hold: hold.name, customer: "users/ada" } });
      return { resources: r.resources, state: r.state };
    }`,
  });
  assert.equal(out.status, "paused", JSON.stringify(out));
  assert.equal(club.reservations.size, 0, "nothing is booked before approval");
  if (out.status !== "paused") return;
  const done = completed(await runtime.approve({ executionId: out.executionId }));
  assert.deepEqual(done, { resources: ["resources/court-1"], state: "RESERVATION_STATE_CONFIRMED" });
  assert.equal(club.holds.size, 1, "replay reuses the logged hold instead of taking another");
});

test("a rejected booking leaves no reservation, and rollback frees the hold", async () => {
  const { club, runtime } = setup();
  const out = await runtime.execute({
    code: `async () => {
      const hold = await holds.createHold({ hold: { window: ${window} } });
      return reservations.createReservation({ reservation: { hold: hold.name } });
    }`,
  });
  assert.equal(out.status, "paused");
  if (out.status !== "paused") return;
  const seq = out.pending[0]?.seq ?? -1;
  assert.equal(await runtime.reject({ executionId: out.executionId, seq }), true);
  assert.equal(club.reservations.size, 0);
  await runtime.rollback({ executionId: out.executionId });
  assert.deepEqual(
    [...club.holds.values()].map((h) => h.state),
    ["HOLD_STATE_RELEASED"],
  );
});

test("rollback releases a hold taken by a script that failed", async () => {
  const { club, runtime } = setup();
  const out = await runtime.execute({
    code: `async () => {
      const hold = await holds.createHold({ hold: { window: ${window}, quantity: 2 } });
      await holds.extendHold({ name: hold.name, duration: "999999s" });
    }`,
  });
  assert.equal(out.status, "error");
  if (out.status !== "error") return;
  await runtime.rollback({ executionId: out.executionId });
  assert.deepEqual(
    [...club.holds.values()].map((h) => h.state),
    ["HOLD_STATE_RELEASED"],
  );
});

test("double booking fails with the engine's error code, caught in the sandbox", async () => {
  const { runtime } = setup();
  const out = await runtime.execute({
    code: `async () => {
      await holds.createHold({ hold: { window: ${window}, quantity: 4 } });
      try { await holds.createHold({ hold: { window: ${window} } }); } catch (e) { return e.code; }
    }`,
  });
  assert.equal(completed(out), "RESOURCE_EXHAUSTED");
});

test("an unconfirmed hold expires and frees its court", async () => {
  const { clock, runtime } = setup();
  const take = `async () => (await holds.createHold({ hold: { window: ${window}, quantity: 4 } })).name`;
  const name = completed(await runtime.execute({ code: take }));
  clock.now += 16 * 60 * 1000;
  const state = await runtime.execute({ code: `async () => (await holds.getHold({ name: "${name}" })).state` });
  assert.equal(completed(state), "HOLD_STATE_EXPIRED");
  assert.equal(typeof completed(await runtime.execute({ code: take })), "string");
});

test("moving a booking keeps the court when the new hold replaces the old", async () => {
  const { runtime } = setup();
  const later = JSON.stringify({ startTime: "2026-12-01T19:30:00Z", endTime: "2026-12-01T20:30:00Z" });
  const book = await runtime.execute({
    code: `async () => {
      const hold = await holds.createHold({ hold: { window: ${window}, candidateResources: ["resources/court-4"] } });
      const r = await reservations.createReservation({ reservation: { hold: hold.name } });
      const moved = await holds.createHold({ hold: { window: ${later}, candidateResources: ["resources/court-4"], replaces: hold.name } });
      const next = await reservations.rescheduleReservation({ name: r.name, hold: moved.name });
      const old = await reservations.getReservation({ name: r.name });
      return { court: next.resources, start: next.startTime, old: old.state };
    }`,
  });
  assert.equal(book.status, "paused");
  if (book.status !== "paused") return;
  let out = await runtime.approve({ executionId: book.executionId });
  assert.equal(out.status, "paused", "rescheduling needs its own approval");
  if (out.status !== "paused") return;
  out = await runtime.approve({ executionId: out.executionId });
  assert.deepEqual(completed(out), {
    court: ["resources/court-4"],
    start: "2026-12-01T19:30:00Z",
    old: "RESERVATION_STATE_RESCHEDULED",
  });
});

test("filters the club cannot evaluate are refused, not ignored", async () => {
  const { runtime } = setup();
  const out = await runtime.execute({
    code: `async () => {
      try {
        await availability.searchAvailability({ window: ${window}, filter: 'resource_types = "padel-court"' });
      } catch (e) { return e.code; }
    }`,
  });
  assert.equal(completed(out), "INVALID_ARGUMENT");
});

test("a retried hold with the same request_id is the same hold; request_id must be a UUID", async () => {
  const { club, runtime } = setup();
  const out = await runtime.execute({
    code: `async () => {
      const requestId = "0b9f6c1e-4c4d-4f0a-9d1e-6f2b8a7c3e15";
      const a = await holds.createHold({ hold: { window: ${window} }, requestId });
      const b = await holds.createHold({ hold: { window: ${window} }, requestId });
      try {
        await holds.createHold({ hold: { window: ${window} }, requestId: "booking-1" });
      } catch (e) {
        return { same: a.name === b.name, code: e.code };
      }
    }`,
  });
  assert.deepEqual(completed(out), { same: true, code: "INVALID_ARGUMENT" });
  assert.equal(club.holds.size, 1);
});

test("resourceTypes matches a court with any of the listed types, as freebusy does", async () => {
  const { runtime } = setup();
  const out = await runtime.execute({
    code: `async () => {
      const found = await availability.searchAvailability({ window: ${window}, resourceTypes: ["indoor", "tennis"] });
      return found.matches.map((m) => m.resource);
    }`,
  });
  assert.deepEqual(completed(out), ["resources/court-1", "resources/court-2", "resources/court-4"]);
});
