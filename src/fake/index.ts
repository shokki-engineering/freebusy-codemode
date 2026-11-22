// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

// An in-memory freebusy for the demo: a four-court club, enough of the engine
// to find, hold, book, move and cancel. Point FREEBUSY_URL at a real server to
// use freebusy itself instead.

import { StatusError } from "@the-protobuf-project/errors";
import type { WebhookService } from "../../gen/freebusy/webhook/v1/index.ts";
import type { Services } from "../../gen/index.ts";
import { availabilityService } from "./availability.ts";
import { holdService } from "./holds.ts";
import { Club } from "./ledger.ts";
import { reservationService } from "./reservations.ts";

export { Club } from "./ledger.ts";

/** Webhooks need a real freebusy: every call fails with UNIMPLEMENTED. */
const noWebhooks = new Proxy({} as WebhookService, {
  get: (_, method) => async () => {
    throw new StatusError("UNIMPLEMENTED", `webhooks.${String(method)} needs a real freebusy: set FREEBUSY_URL`);
  },
});

/** The four sandbox namespaces, served from one in-memory club. */
export function inMemoryFreebusy(club = new Club()): Services {
  return {
    availability: availabilityService(club),
    holds: holdService(club),
    reservations: reservationService(club),
    webhooks: noWebhooks,
  };
}
