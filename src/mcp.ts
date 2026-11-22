// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

// Serves freebusy over MCP on stdio as one `code` tool. Add it to Claude Code:
//
//   claude mcp add freebusy -- bun "$PWD/src/mcp.ts"
//
// The model cannot approve its own calls: approvals come from MCP elicitation
// when the client supports it, and otherwise from a person on the local page
// at http://127.0.0.1:4791 (CODEMODE_APPROVALS_PORT).
//
// Without FREEBUSY_URL it books courts at an in-memory club. Executions are
// kept in SQLite (CODEMODE_DB), so one paused for approval survives a restart.

import { DatabaseSync } from "node:sqlite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type SqliteDatabase, SqliteStore } from "@the-protobuf-project/codemode";
import { serveApprovals } from "./approvals.ts";
import { freebusyCodemode, freebusyMcp } from "./runtime.ts";
import { freebusyFromEnv } from "./services.ts";

const port = Number(process.env.CODEMODE_APPROVALS_PORT ?? 4791);
const db = new DatabaseSync(process.env.CODEMODE_DB ?? ":memory:") as unknown as SqliteDatabase;
const runtime = freebusyCodemode(freebusyFromEnv(), new SqliteStore(db));

serveApprovals(runtime, port).on("error", (e) => console.error(`approval page: ${e.message}`));
const server = freebusyMcp(runtime, port);
await server.connect(new StdioServerTransport());
