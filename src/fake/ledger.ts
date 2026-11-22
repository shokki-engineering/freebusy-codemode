// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

// The state behind the in-memory freebusy: a small padel club, and a ledger of
// who holds which court when. The real engine keeps this in Postgres and
// rejects double booking with an exclusion constraint; here one array does.

import { StatusError } from "@the-protobuf-project/errors";
import type { Hold } from "../../gen/freebusy/allocation/v1/index.ts";
import type { Reservation } from "../../gen/freebusy/reservation/v1/index.ts";
import type { Interval } from "../../gen/google/type/index.ts";

/** A bookable resource, as RFC 9073 would describe it. */
export interface Court {
  name: string;
  displayName: string;
  types: string[];
}

/** A resource taken for a window by a hold, and by the reservation made of it. */
interface Claim {
  resource: string;
  start: number;
  end: number;
  hold: string;
}

/** A half-open window in epoch milliseconds. */
export interface Span {
  start: number;
  end: number;
}

export const HOLD_TTL_MS = 15 * 60 * 1000;

/** Reads a google.type.Interval, rejecting empty or reversed windows. */
export function span(window: Interval | undefined, field = "window"): Span {
  const start = Date.parse(window?.startTime ?? "");
  const end = Date.parse(window?.endTime ?? "");
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new StatusError("INVALID_ARGUMENT", `${field}: start_time and end_time must be RFC 3339 timestamps`);
  }
  if (end <= start) throw new StatusError("INVALID_ARGUMENT", `${field}: end_time must be after start_time`);
  return { start, end };
}

/** Formats epoch milliseconds as the RFC 3339 string protojson uses. */
export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** Parses a protojson Duration such as "900s". */
export function seconds(duration: string): number {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(duration);
  if (!m?.[1]) throw new StatusError("INVALID_ARGUMENT", `duration: ${JSON.stringify(duration)} is not like "900s"`);
  return Number(m[1]);
}

export class Club {
  readonly courts: Court[] = [
    { name: "resources/court-1", displayName: "Court 1", types: ["padel", "indoor"] },
    { name: "resources/court-2", displayName: "Court 2", types: ["padel", "indoor"] },
    { name: "resources/court-3", displayName: "Court 3", types: ["padel", "outdoor"] },
    { name: "resources/court-4", displayName: "Centre court", types: ["tennis", "outdoor"] },
  ];
  readonly holds = new Map<string, Hold>();
  readonly reservations = new Map<string, Reservation>();
  /** request_id -> hold name, so a retried createHold returns the same hold. */
  readonly requests = new Map<string, string>();
  private claims: Claim[] = [];
  private seq = 0;

  readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A new resource id, e.g. "h7". */
  id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  court(name: string): Court {
    const court = this.courts.find((c) => c.name === name);
    if (!court) throw new StatusError("NOT_FOUND", `${name} is not a resource of this club`);
    return court;
  }

  /** Courts free for the whole span, ignoring claims of the hold being replaced. */
  free(resources: string[], s: Span, ignoreHold?: string): string[] {
    this.sweep();
    return resources.filter(
      (r) => !this.claims.some((c) => c.resource === r && c.hold !== ignoreHold && c.start < s.end && s.start < c.end),
    );
  }

  take(hold: string, resources: string[], s: Span): void {
    for (const resource of resources) this.claims.push({ resource, hold, ...s });
  }

  drop(hold: string): void {
    this.claims = this.claims.filter((c) => c.hold !== hold);
  }

  /** Expires lapsed holds, as freebusy's sweeper and authoritative reads do. */
  sweep(): void {
    for (const hold of this.holds.values()) {
      if (hold.state === "HOLD_STATE_ACTIVE" && Date.parse(hold.expireTime ?? "") <= this.now()) {
        hold.state = "HOLD_STATE_EXPIRED";
        hold.updateTime = iso(this.now());
        this.drop(hold.name ?? "");
      }
    }
  }

  hold(name: string): Hold {
    this.sweep();
    const hold = this.holds.get(name);
    if (!hold) throw new StatusError("NOT_FOUND", `${name} does not exist`);
    return hold;
  }

  reservation(name: string): Reservation {
    const reservation = this.reservations.get(name);
    if (!reservation) throw new StatusError("NOT_FOUND", `${name} does not exist`);
    return reservation;
  }
}
