// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

// Chooses what the sandbox talks to: a real freebusy over its REST gateway when
// FREEBUSY_URL is set, otherwise the in-memory club.

import { httpTransport } from "@the-protobuf-project/network";
import { AllocationServiceClient, HoldServiceClient } from "../gen/freebusy/allocation/v1/index.ts";
import { ReservationServiceClient } from "../gen/freebusy/reservation/v1/index.ts";
import { WebhookServiceClient } from "../gen/freebusy/webhook/v1/index.ts";
import type { Services } from "../gen/index.ts";
import { inMemoryFreebusy } from "./fake/index.ts";

/**
 * Generated clients over freebusy's google.api.http routes (grpc-gateway).
 * FREEBUSY_TOKEN, when set, is sent as a bearer token.
 */
export function remoteFreebusy(baseUrl: string, token?: string): Services {
  const transport = httpTransport({
    baseUrl,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    availability: new AllocationServiceClient(transport),
    holds: new HoldServiceClient(transport),
    reservations: new ReservationServiceClient(transport),
    webhooks: new WebhookServiceClient(transport),
  };
}

export function freebusyFromEnv(env: Record<string, string | undefined> = process.env): Services {
  const url = env.FREEBUSY_URL;
  return url ? remoteFreebusy(url, env.FREEBUSY_TOKEN) : inMemoryFreebusy();
}
