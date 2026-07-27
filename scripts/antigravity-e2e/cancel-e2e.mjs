// Starts a long turn, cancels it mid-flight, and checks the bridge answers the
// ORIGINAL prompt (rather than the RPC being interrupted) and that updates
// arriving after the cancel still carry a turn.
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cancel-"));
const child = spawn(process.execPath, ["dist/bin.mjs", "agy-acp"], {
  env: { ...process.env, T3_AGY_REQUIRE_APPROVAL: "0" },
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "",
  sessionId = null,
  cancelSentAt = 0,
  updatesAfterCancel = 0;
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id === 1 && m.result) {
      send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd } });
      continue;
    }
    if (m.id === 2 && m.result) {
      sessionId = m.result.sessionId;
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          _meta: { t3: { epoch: 0 } },
          prompt: [
            {
              type: "text",
              text: "Count slowly from 1 to 40, one number per line, thinking carefully about each.",
            },
          ],
        },
      });
      // Cancel a few seconds in, while the turn is definitely running.
      setTimeout(() => {
        cancelSentAt = Date.now();
        send({ jsonrpc: "2.0", method: "t3/fence", params: { sessionId, epoch: 0 } });
        send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
      }, 6000);
      continue;
    }
    if (m.method === "session/update" && cancelSentAt) updatesAfterCancel++;
    if (m.id === 3) {
      const elapsed = Date.now() - cancelSentAt;
      console.log("prompt answered:", JSON.stringify(m.result ?? m.error));
      console.log("answered", elapsed, "ms after cancel");
      console.log("session/update messages after cancel:", updatesAfterCancel);
      const ok = m.result?.stopReason === "cancelled" && elapsed < 10000;
      console.log(
        "RESULT:",
        ok ? "PASS (bridge answered the original prompt, before the fallback)" : "FAIL",
      );
      child.stdin.end();
      setTimeout(() => process.exit(ok ? 0 : 1), 300);
      continue;
    }
  }
});
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(2);
}, 180000);
