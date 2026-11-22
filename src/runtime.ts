// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

import { type CodemodeRuntime, createCodemode, type Store } from "@the-protobuf-project/codemode";
import { createMcpServer } from "@the-protobuf-project/codemode/mcp";
import { QuickJSExecutor } from "@the-protobuf-project/codemode/quickjs";
import { catalog, config, connectors, type Services } from "../gen/index.ts";

/** Code Mode over freebusy: the generated catalog, the policy from codemode.yaml, and a QuickJS sandbox. */
export function freebusyCodemode(services: Services, store?: Store): CodemodeRuntime {
  return createCodemode({
    catalog,
    config,
    connectors: connectors(services),
    executor: new QuickJSExecutor(),
    ...(store ? { store } : {}),
  });
}

/**
 * The MCP server: a `code` tool and `codemode_status`. The model cannot approve
 * its own calls; a person approves through elicitation or the page on port.
 */
export function freebusyMcp(runtime: CodemodeRuntime, port: number) {
  return createMcpServer(runtime, {
    name: "freebusy",
    expose: config.mcp?.expose ?? "code",
    approvalTools: false,
    approvalHint:
      `A person must approve this call. Ask the user to open http://127.0.0.1:${port} and approve or reject it, ` +
      "then call codemode_status with this executionId. The script may pause again for later calls, which the user " +
      "approves on the same page, so report every call codemode_status lists as approved. Do not retry the script.",
  });
}
