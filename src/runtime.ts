// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type CodemodeRuntime, type CodeOutput, createCodemode, type Store } from "@the-protobuf-project/codemode";
import { createMcpServer } from "@the-protobuf-project/codemode/mcp";
import { QuickJSExecutor } from "@the-protobuf-project/codemode/quickjs";
import { catalog, config, connectors, type Services } from "../gen/index.ts";
import { type Approver, elicitationApprover, settle } from "./approver.ts";

/** What rolling back an execution undid, kept until the output that reports it is shaped. */
const undone = new Map<string, string>();

/** Takes the note on what rollback undid for an execution, if any. */
export function rollbackNote(executionId: string): string | undefined {
  const note = undone.get(executionId);
  undone.delete(executionId);
  return note;
}

/**
 * Code Mode over freebusy: the generated catalog, the policy from codemode.yaml, and a QuickJS sandbox.
 *
 * An execution that ends in an error or a rejection is rolled back as it ends, so a script that took a
 * hold and then failed, diverged on replay, or had its booking rejected never keeps a court. The error
 * the model sees says what was undone.
 */
export function freebusyCodemode(services: Services, store?: Store): CodemodeRuntime {
  const runtime: CodemodeRuntime = createCodemode({
    catalog,
    config,
    connectors: connectors(services),
    executor: new QuickJSExecutor(),
    ...(store ? { store } : {}),
    hooks: {
      async disposeExecution(executionId, status) {
        if (status !== "error" && status !== "rejected") return;
        try {
          const r = await runtime.rollback({ executionId });
          const parts = [];
          if (r.reverted.length > 0) parts.push(`Rolled back: ${r.reverted.join(", ")}.`);
          for (const f of r.failures) parts.push(`Could not roll back ${f.path}: ${f.error}`);
          if (parts.length > 0) undone.set(executionId, parts.join(" "));
        } catch (e) {
          undone.set(executionId, `Rollback failed: ${(e as Error).message}`);
        }
      },
    },
  });

  const note = (out: CodeOutput): CodeOutput => {
    const what = out.status === "error" ? rollbackNote(out.executionId) : undefined;
    return out.status === "error" && what ? { ...out, error: `${out.error} ${what}` } : out;
  };
  const execute = runtime.execute.bind(runtime);
  const approve = runtime.approve.bind(runtime);
  runtime.execute = async (input) => note(await execute(input));
  runtime.approve = async (args) => note(await approve(args));
  return runtime;
}

/**
 * The MCP server: a `code` tool and `codemode_status`. The model cannot approve
 * its own calls. Each paused call goes to the approver, by default MCP
 * elicitation with an explicit Approve or Reject; a call it defers waits for a
 * person on the page on port. Pass another approver, e.g. an A2UI surface, to
 * ask the person there instead.
 */
export function freebusyMcp(runtime: CodemodeRuntime, port: number, approver?: (server: Server) => Approver) {
  // The package's own elicitation is off: its single checkbox let a client approve by accepting the form.
  const asking: CodemodeRuntime = Object.create(runtime);
  const server = createMcpServer(asking, {
    name: "freebusy",
    expose: config.mcp?.expose ?? "code",
    approvalTools: false,
    elicitApproval: false,
    approvalHint:
      `A person must approve this call. Ask the user to open http://127.0.0.1:${port} and approve or reject it, ` +
      "then call codemode_status with this executionId. The script may pause again for later calls, which the user " +
      "approves on the same page, so report every call codemode_status lists as approved. Do not retry the script.",
  });
  const decide = (approver ?? elicitationApprover)(server);
  asking.execute = async (input) => settle(runtime, await runtime.execute(input), decide);
  return server;
}
