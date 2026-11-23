// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

// Books a padel court through Code Mode the way a model would: one script that
// searches, holds and confirms, pausing for a person before the booking is
// made. Run with `bun run demo`; set FREEBUSY_URL to use a real freebusy.

import type { CodeOutput } from "@the-protobuf-project/codemode";
import { freebusyCodemode } from "./runtime.ts";
import { freebusyFromEnv } from "./services.ts";

const runtime = freebusyCodemode(freebusyFromEnv().services);

function show(title: string, out: unknown): void {
  console.log(`\n== ${title}\n${JSON.stringify(out, null, 2)}`);
}

const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

show(
  "One script, many calls: free indoor padel courts tomorrow evening, hour by hour",
  await runtime.execute({
    code: `async () => {
      const day = "${tomorrow}";
      const out = [];
      for (const hour of [18, 19, 20]) {
        const window = { startTime: day + "T" + hour + ":00:00Z", endTime: day + "T" + (hour + 1) + ":00:00Z" };
        // resourceTypes matches any listed type, so narrow padel courts to indoor ones here.
        const found = await availability.searchAvailability({ window, resourceTypes: ["padel"] });
        const indoor = found.matches.filter((m) => m.resourceTypes.includes("indoor"));
        out.push({ hour, courts: indoor.map((m) => m.displayName) });
      }
      return out;
    }`,
  }),
);

const booking: CodeOutput = await runtime.execute({
  code: `async () => {
    const window = { startTime: "${tomorrow}T19:00:00Z", endTime: "${tomorrow}T20:30:00Z" };
    const found = await availability.searchAvailability({ window, resourceTypes: ["padel"] });
    if (found.matches.length === 0) return "nothing free";
    const hold = await holds.createHold({
      hold: { window, candidateResources: found.matches.map((m) => m.resource) },
      requestId: "${crypto.randomUUID()}",
    });
    const reservation = await reservations.createReservation({
      reservation: { hold: hold.name, customer: "users/ada", attributes: { players: 4 } },
    });
    return { court: reservation.resources, reservation: reservation.name, state: reservation.state };
  }`,
});
show("Booking: the hold is taken, then the script pauses before createReservation", booking);

if (booking.status === "paused") {
  show(
    "Approved: resumes from the log without taking a second hold",
    await runtime.approve({ executionId: booking.executionId }),
  );
}

const failing = await runtime.execute({
  code: `async () => {
    const window = { startTime: "${tomorrow}T07:00:00Z", endTime: "${tomorrow}T08:00:00Z" };
    const hold = await holds.createHold({ hold: { window, quantity: 2 } });
    await holds.extendHold({ name: hold.name, duration: "999999s" });
  }`,
});
show("A script fails after taking a hold", failing);
if (failing.status === "error") {
  show(
    "Rollback: the generated revert releases the hold",
    await runtime.rollback({ executionId: failing.executionId }),
  );
}

console.log(
  `\n== What the model sees for one method\n${(await runtime.describe("holds.createHold")).types.split("\n").slice(0, 12).join("\n")}`,
);
