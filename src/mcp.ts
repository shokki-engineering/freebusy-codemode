// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

// Serves freebusy over MCP on stdio as one `code` tool. Add it to Claude Code:
//
//   claude mcp add freebusy -- bun "$PWD/src/mcp.ts"
//
// The model cannot approve its own calls: approvals come from MCP elicitation
// when the client supports it (FREEBUSY_APPROVAL=prompt, the default; =page
// skips it), and otherwise from a person on a local page,
// http://127.0.0.1:4791 (CODEMODE_APPROVALS_PORT) or, when that port is taken,
// the free port named in the paused result.
//
// Without FREEBUSY_URL it books courts at an in-memory club, whose state lives
// in this process. Paused executions then stay in memory too: resuming one in
// another process, or after a restart, would replay it against an empty club.
// With FREEBUSY_URL, CODEMODE_DB keeps them in SQLite across restarts.

import { DatabaseSync } from "node:sqlite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryStore, type SqliteDatabase, SqliteStore, type Store } from "@the-protobuf-project/codemode";
import { serveApprovals } from "./approvals.ts";
import { approverFromEnv } from "./approver.ts";
import { freebusyCodemode, freebusyMcp } from "./runtime.ts";
import { freebusyFromEnv } from "./services.ts";

const { services, remote } = freebusyFromEnv();
const dbPath = process.env.CODEMODE_DB;
let store: Store = new MemoryStore();
if (remote && dbPath) {
  store = new SqliteStore(new DatabaseSync(dbPath) as unknown as SqliteDatabase);
} else if (dbPath) {
  console.error("CODEMODE_DB ignored: the in-memory club's executions only resume in the process that made them");
}

const approver = approverFromEnv(process.env.FREEBUSY_APPROVAL);
const runtime = freebusyCodemode(services, store);
const { port } = await serveApprovals(runtime, Number(process.env.CODEMODE_APPROVALS_PORT ?? 4791));
console.error(`approvals: http://127.0.0.1:${port}`);
await freebusyMcp(runtime, port, approver).connect(new StdioServerTransport());
