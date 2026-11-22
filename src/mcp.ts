// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

// Serves freebusy over MCP on stdio as one `code` tool. Add it to Claude Code:
//
//   claude mcp add freebusy -- bun "$PWD/src/mcp.ts"
//
// Without FREEBUSY_URL it books courts at an in-memory club. Executions are
// kept in SQLite (CODEMODE_DB), so one paused for approval survives a restart.

import { DatabaseSync } from "node:sqlite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type SqliteDatabase, SqliteStore } from "@the-protobuf-project/codemode";
import { createMcpServer } from "@the-protobuf-project/codemode/mcp";
import { config } from "../gen/index.ts";
import { freebusyCodemode } from "./runtime.ts";
import { freebusyFromEnv } from "./services.ts";

const db = new DatabaseSync(process.env.CODEMODE_DB ?? ":memory:") as unknown as SqliteDatabase;
const runtime = freebusyCodemode(freebusyFromEnv(), new SqliteStore(db));
const server = createMcpServer(runtime, { name: "freebusy", expose: config.mcp?.expose ?? "code" });
await server.connect(new StdioServerTransport());
