// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

// Who decides on a call that needs a person's approval. The MCP server asks an
// Approver for each paused call; today that is MCP elicitation, and an A2UI
// surface can take its place by implementing the same function.
//
// Only an explicit "approve" runs a call. A form a client cannot render, an
// answer with no decision, or anything unexpected defers the call to the local
// approval page instead, so a client that auto-accepts a prompt cannot approve.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CodemodeRuntime, CodeOutput, PendingAction } from "@the-protobuf-project/codemode";
import { rollbackNote } from "./runtime.ts";

/** approve: run the call. reject: end the execution. defer: leave it paused for another surface. */
export type Decision = "approve" | "reject" | "defer";

/** Decides one paused call. */
export type Approver = (call: PendingAction) => Promise<Decision>;

/** How long a person has to answer the prompt before the call is left waiting on the page. */
export const promptTimeoutMs = 10 * 60 * 1000;

/** Asks the person through MCP elicitation: a required choice between Reject and Approve, with no default. */
export function elicitationApprover(server: Server, timeoutMs = promptTimeoutMs): Approver {
  return async (call) => {
    if (!server.getClientCapabilities()?.elicitation) return "defer";
    let answer: Awaited<ReturnType<Server["elicitInput"]>>;
    try {
      answer = await server.elicitInput(
        {
          mode: "form",
          message:
            `${call.message ?? `Allow ${call.path}?`}\n\n${call.path}(${JSON.stringify(call.args, null, 2)})\n\n` +
            "Choose Approve to run this call, or Reject to stop the script and roll it back.",
          requestedSchema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                title: `${call.path}`,
                oneOf: [
                  { const: "reject", title: "Reject" },
                  { const: "approve", title: "Approve" },
                ],
              },
            },
            required: ["decision"],
          },
        },
        { timeout: timeoutMs },
      );
    } catch {
      return "defer";
    }
    if (answer.action === "decline" || answer.action === "cancel") return "reject";
    const decision = answer.content?.decision;
    if (decision === "approve") return "approve";
    if (decision === "reject") return "reject";
    return "defer";
  };
}

/** Never asks: every paused call waits for a person on the local approval page. */
export function pageApprover(): Approver {
  return async () => "defer";
}

/**
 * The approver FREEBUSY_APPROVAL names: "prompt" (the default) asks through MCP
 * elicitation, "page" sends every call to the local approval page.
 */
export function approverFromEnv(value: string | undefined): (server: Server) => Approver {
  if (value === undefined || value === "" || value === "prompt") return (server) => elicitationApprover(server);
  if (value === "page") return () => pageApprover();
  throw new Error(`FREEBUSY_APPROVAL must be "prompt" or "page", not ${JSON.stringify(value)}`);
}

/** While an execution is paused, asks the approver about its next call and resumes or rejects it. */
export async function settle(runtime: CodemodeRuntime, out: CodeOutput, approver: Approver): Promise<CodeOutput> {
  let current = out;
  while (current.status === "paused") {
    const call = current.pending[0];
    if (!call) break;
    const decision = await approver(call);
    if (decision === "defer") break;
    if (decision === "approve") {
      current = await runtime.approve({ executionId: current.executionId, seq: call.seq });
      continue;
    }
    await runtime.reject({ executionId: current.executionId, seq: call.seq });
    const undone = rollbackNote(current.executionId);
    return {
      status: "error",
      executionId: current.executionId,
      error: `The person rejected ${call.path}.${undone ? ` ${undone}` : ""}`,
    };
  }
  return current;
}
