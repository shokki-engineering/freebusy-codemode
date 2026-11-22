// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

import { StatusError } from "@the-protobuf-project/errors";
import type {
  AllocationService,
  AvailabilityBucket,
  BatchComputeAvailabilityRequest,
  BatchComputeAvailabilityResponse,
  CheckAvailabilityRequest,
  CheckAvailabilityResponse,
  ComputeAvailabilityRequest,
  ComputeAvailabilityResponse,
  SearchAvailabilityRequest,
  SearchAvailabilityResponse,
} from "../../gen/freebusy/allocation/v1/index.ts";
import { type Club, iso, noFilter, seconds, span } from "./ledger.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BUCKETS = 500;

/** AllocationService over the in-memory club: read-only answers about free courts. */
export function availabilityService(club: Club): AllocationService {
  const resourcesOf = (names: string[] | undefined) =>
    names?.length ? names.map((n) => club.court(n).name) : club.courts.map((c) => c.name);

  async function computeAvailability(req: ComputeAvailabilityRequest): Promise<ComputeAvailabilityResponse> {
    noFilter(req.filter);
    const window = span(req.window);
    const resources = resourcesOf(req.resources);
    const step =
      req.granularity === "AVAILABILITY_GRANULARITY_DAY" ? DAY_MS : seconds(req.slotDuration || "3600s") * 1000;
    if ((window.end - window.start) / step > MAX_BUCKETS) {
      throw new StatusError("INVALID_ARGUMENT", `window holds more than ${MAX_BUCKETS} buckets: use a longer slot`);
    }
    const buckets: AvailabilityBucket[] = [];
    for (let start = window.start; start < window.end; start += step) {
      const end = Math.min(start + step, window.end);
      const free = club.free(resources, { start, end });
      buckets.push({
        window: { startTime: iso(start), endTime: iso(end) },
        freeCount: free.length,
        totalCount: resources.length,
        ...(req.includeFreeResources ? { freeResources: free } : {}),
      });
    }
    return { buckets, totalCount: resources.length };
  }

  return {
    computeAvailability,

    async checkAvailability(req: CheckAvailabilityRequest): Promise<CheckAvailabilityResponse> {
      noFilter(req.filter);
      const resources = resourcesOf(req.resources);
      const free = club.free(resources, span(req.window));
      const quantity = req.quantity || 1;
      return {
        bookable: free.length >= quantity,
        freeCount: free.length,
        candidateResources: free,
        reasons: resources
          .filter((r) => !free.includes(r))
          .map((resource) => ({
            code: "UNBOOKABLE_REASON_CODE_BOOKED",
            message: "taken for part of the window",
            resource,
          })),
      };
    },

    async batchComputeAvailability(req: BatchComputeAvailabilityRequest): Promise<BatchComputeAvailabilityResponse> {
      return { responses: await Promise.all(req.requests.map(computeAvailability)) };
    },

    async searchAvailability(req: SearchAvailabilityRequest): Promise<SearchAvailabilityResponse> {
      noFilter(req.filter);
      const window = span(req.window);
      const wanted = req.resourceTypes ?? [];
      const courts = club.courts.filter((c) => wanted.every((t) => c.types.includes(t)));
      const free = new Set(
        club.free(
          courts.map((c) => c.name),
          window,
        ),
      );
      const matches = courts
        .filter((c) => free.has(c.name))
        .slice(0, req.pageSize || 50)
        .map((c) => ({ resource: c.name, window: req.window, resourceTypes: c.types, displayName: c.displayName }));
      return { matches };
    },
  };
}
