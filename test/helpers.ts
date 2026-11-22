// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import type { CodeOutput } from "@the-protobuf-project/codemode";
import { Club, inMemoryFreebusy } from "../src/fake/index.ts";
import { freebusyCodemode } from "../src/runtime.ts";

/** A fresh club and runtime, with a clock the test can move. */
export function setup(start = Date.parse("2026-12-01T09:00:00Z")) {
  const clock = { now: start };
  const club = new Club(() => clock.now);
  const runtime = freebusyCodemode(inMemoryFreebusy(club));
  return { club, clock, runtime };
}

export function completed(out: CodeOutput): unknown {
  assert.equal(out.status, "completed", JSON.stringify(out));
  return out.status === "completed" ? out.result : undefined;
}

/** An evening window on the test day. */
export const evening = { startTime: "2026-12-01T19:00:00Z", endTime: "2026-12-01T20:00:00Z" };
