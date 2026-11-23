// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

import { StatusError } from "@the-protobuf-project/errors";
import type { Empty } from "@the-protobuf-project/protobuf";
import type {
  CreateHoldRequest,
  DeleteHoldRequest,
  ExtendHoldRequest,
  GetHoldRequest,
  Hold,
  HoldName,
  HoldService,
  ListHoldsRequest,
  ListHoldsResponse,
  ReleaseHoldRequest,
} from "../../gen/freebusy/allocation/v1/index.ts";
import { type Club, HOLD_TTL_MS, iso, noFilter, seconds, span } from "./ledger.ts";

const MAX_EXTEND_S = 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** HoldService over the in-memory club: takes, extends and releases claims. */
export function holdService(club: Club): HoldService {
  return {
    async createHold({ hold, holdId, requestId }: CreateHoldRequest): Promise<Hold> {
      if (requestId && !UUID.test(requestId)) {
        throw new StatusError("INVALID_ARGUMENT", `request_id must be a valid UUID; got "${requestId}".`);
      }
      const retried = requestId ? club.requests.get(requestId) : undefined;
      if (retried) return club.hold(retried);
      noFilter(hold.candidateFilter, "hold.candidate_filter");
      const window = span(hold.window, "hold.window");
      const quantity = hold.quantity || 1;
      if (quantity < 1) throw new StatusError("INVALID_ARGUMENT", "hold.quantity must be at least 1");
      const candidates = hold.candidateResources?.length
        ? hold.candidateResources.map((r) => club.court(r).name)
        : club.courts.map((c) => c.name);
      const free = club.free(candidates, window, hold.replaces);
      if (free.length < quantity) {
        throw new StatusError("RESOURCE_EXHAUSTED", `only ${free.length} of ${quantity} requested resources are free`, {
          reason: "CAPACITY_EXHAUSTED",
        });
      }
      const name = `holds/${holdId || club.id("h")}` as HoldName;
      if (club.holds.has(name)) throw new StatusError("ALREADY_EXISTS", `${name} already exists`);
      const now = club.now();
      const taken: Hold = {
        ...hold,
        name,
        resources: free.slice(0, quantity),
        quantity,
        state: "HOLD_STATE_ACTIVE",
        expireTime: iso(now + HOLD_TTL_MS),
        createTime: iso(now),
        updateTime: iso(now),
        etag: club.id("e"),
      };
      club.holds.set(name, taken);
      club.take(name, taken.resources ?? [], window);
      if (requestId) club.requests.set(requestId, name);
      return taken;
    },

    async getHold({ name }: GetHoldRequest): Promise<Hold> {
      return club.hold(name);
    },

    async listHolds({ filter }: ListHoldsRequest): Promise<ListHoldsResponse> {
      noFilter(filter);
      club.sweep();
      return { holds: [...club.holds.values()] };
    },

    async extendHold({ name, duration }: ExtendHoldRequest): Promise<Hold> {
      const hold = club.hold(name);
      if (hold.state !== "HOLD_STATE_ACTIVE") {
        throw new StatusError("FAILED_PRECONDITION", `${name} is ${hold.state}, not active`, {
          reason: "HOLD_NOT_ACTIVE",
        });
      }
      const s = seconds(duration);
      if (s > MAX_EXTEND_S) throw new StatusError("INVALID_ARGUMENT", "duration: at most 24 hours");
      hold.expireTime = iso(club.now() + s * 1000);
      hold.updateTime = iso(club.now());
      return hold;
    },

    async releaseHold({ name }: ReleaseHoldRequest): Promise<Hold> {
      const hold = club.hold(name);
      if (hold.state === "HOLD_STATE_CONVERTED") {
        throw new StatusError("FAILED_PRECONDITION", `${name} became a reservation; cancel the reservation instead`);
      }
      if (hold.state === "HOLD_STATE_ACTIVE") {
        hold.state = "HOLD_STATE_RELEASED";
        hold.updateTime = iso(club.now());
        club.drop(name);
      }
      return hold;
    },

    async deleteHold({ name }: DeleteHoldRequest): Promise<Empty> {
      if (club.hold(name).state === "HOLD_STATE_ACTIVE") {
        throw new StatusError("FAILED_PRECONDITION", `${name} is active: release it first`);
      }
      club.holds.delete(name);
      return {};
    },
  };
}
