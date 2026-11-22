// Copyright 2026 Srikanth K.
// SPDX-License-Identifier: Apache-2.0

// A local page where a person approves or rejects paused calls. The MCP server
// hides codemode_approve from the model, so for clients without elicitation
// this page is the only way a booking goes through.
//
// It listens on 127.0.0.1 only, checks the Host header against DNS rebinding,
// and accepts a POST only from its own origin, so another website open in the
// same browser cannot approve on your behalf. Any local program can still
// reach it, like anything else on localhost.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { CodemodeRuntime, PendingAction } from "@the-protobuf-project/codemode";

const html = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function page(pending: PendingAction[], notice: string): string {
  const rows = pending.map(
    (p) => `<section>
  <h2>${html(p.path)}</h2>
  ${p.message ? `<p>${html(p.message)}</p>` : ""}
  <pre>${html(JSON.stringify(p.args, null, 2))}</pre>
  <form method="post" action="/approve"><input type="hidden" name="executionId" value="${html(p.executionId)}"><button>Approve</button></form>
  <form method="post" action="/reject"><input type="hidden" name="executionId" value="${html(p.executionId)}"><input type="hidden" name="seq" value="${p.seq}"><button class="reject">Reject</button></form>
</section>`,
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>freebusy approvals</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{max-width:44rem;margin:2rem auto;padding:0 1rem}
section{border:1px solid #8886;border-radius:8px;padding:1rem;margin:1rem 0}
pre{overflow:auto;background:#8881;padding:.75rem;border-radius:6px}
form{display:inline}button{font:inherit;padding:.4rem 1rem;margin-right:.5rem;cursor:pointer}
.reject{background:none}
</style></head><body>
<h1>Waiting for you</h1>
${notice ? `<p><strong>${html(notice)}</strong></p>` : ""}
${rows.join("\n") || "<p>Nothing is waiting. Calls that need approval appear here.</p>"}
<p><a href="/">Refresh</a></p>
</body></html>`;
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

/**
 * Serves the approval page for runtime on 127.0.0.1, on port when it is free
 * and on any free port otherwise, e.g. when a client starts the server twice.
 * Resolves with the server and the port it listens on.
 */
export async function serveApprovals(
  runtime: CodemodeRuntime,
  port: number,
): Promise<{ server: Server; port: number }> {
  try {
    return await listen(runtime, port);
  } catch {
    return listen(runtime, 0);
  }
}

function listen(runtime: CodemodeRuntime, wanted: number): Promise<{ server: Server; port: number }> {
  let host = "";
  let origin = "";
  const server = createServer(async (req, res) => {
    const send = (status: number, html: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" }).end(html);
    };
    if (req.headers.host !== host) return send(421, "wrong host");
    if (req.method === "GET" && req.url === "/") return send(200, page(await runtime.pending(), ""));
    if (req.method !== "POST") return send(404, "not found");
    const fetchSite = req.headers["sec-fetch-site"];
    if (req.headers.origin !== origin || (fetchSite && fetchSite !== "same-origin")) {
      return send(403, "approvals are only accepted from this page");
    }
    const fields = await form(req);
    const executionId = fields.get("executionId") ?? "";
    let notice: string;
    try {
      if (req.url === "/approve") {
        const out = await runtime.approve({ executionId });
        notice =
          out.status === "paused" ? "Approved. The script paused again for the next call." : `Approved: ${out.status}.`;
      } else if (req.url === "/reject") {
        await runtime.reject({ executionId, seq: Number(fields.get("seq")) });
        notice = "Rejected. The script stopped; ask Claude to roll it back to free any hold.";
      } else {
        return send(404, "not found");
      }
    } catch (e) {
      notice = `Failed: ${(e as Error).message}`;
    }
    send(200, page(await runtime.pending(), notice));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(wanted, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : wanted;
      host = `127.0.0.1:${port}`;
      origin = `http://${host}`;
      resolve({ server, port });
    });
  });
}
