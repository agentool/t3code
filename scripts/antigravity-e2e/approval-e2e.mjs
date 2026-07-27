// Drives the built bridge over stdio with approvals ON and REJECTS the tool.
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-"));
fs.writeFileSync(path.join(cwd, "marker.txt"), "original\n");

const child = spawn(process.execPath, ["dist/bin.mjs", "agy-acp"], {
  cwd: process.cwd(),
  env: { ...process.env, T3_AGY_REQUIRE_APPROVAL: "1" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
let sessionId = null;
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
let sawPermissionRequest = false;
let toolDenied = false;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg.id === 1 && msg.result) {
      send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd } });
      continue;
    }
    if (msg.id === 2 && msg.result) {
      sessionId = msg.result.sessionId;
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [
            {
              type: "text",
              text: `Use your run_command tool to run: echo PWNED > ${path.join(cwd, "marker.txt")}. Then say DONE.`,
            },
          ],
        },
      });
      continue;
    }
    // The bridge asking US to approve a tool.
    if (msg.method === "session/request_permission") {
      sawPermissionRequest = true;
      console.log(
        "PERMISSION REQUEST:",
        JSON.stringify(msg.params.toolCall?.title),
        "options:",
        msg.params.options.map((o) => o.optionId).join(","),
      );
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { outcome: { outcome: "selected", optionId: "reject" } },
      });
      continue;
    }
    if (msg.id === 3) {
      console.log("PROMPT RESULT:", JSON.stringify(msg.result ?? msg.error).slice(0, 200));
      const after = fs.readFileSync(path.join(cwd, "marker.txt"), "utf8").trim();
      toolDenied = after === "original";
      console.log("FILE AFTER TURN:", JSON.stringify(after));
      console.log(
        `\nRESULT: permission_requested=${sawPermissionRequest} tool_blocked=${toolDenied}`,
      );
      child.stdin.end();
      setTimeout(() => process.exit(sawPermissionRequest && toolDenied ? 0 : 1), 300);
      continue;
    }
  }
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(2);
}, 240000);
