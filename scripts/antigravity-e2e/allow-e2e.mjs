// Approvals ON, user APPROVES: the tool must actually run and the turn complete.
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-allow-"));
fs.writeFileSync(path.join(cwd, "marker.txt"), "original\n");
const child = spawn(process.execPath, ["dist/bin.mjs", "agy-acp"], {
  env: { ...process.env, T3_AGY_REQUIRE_APPROVAL: "1" },
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "",
  approvals = 0,
  toolEvents = [];
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
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: m.result.sessionId,
          prompt: [
            {
              type: "text",
              text: `Use run_command to run exactly: printf 'APPROVED' > ${path.join(cwd, "marker.txt")} . Then say DONE.`,
            },
          ],
        },
      });
      continue;
    }
    if (m.method === "session/request_permission") {
      approvals++;
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: { outcome: { outcome: "selected", optionId: "allow" } },
      });
      continue;
    }
    if (m.method === "session/update" && m.params?.update?.sessionUpdate?.startsWith("tool_call"))
      toolEvents.push(
        `${m.params.update.sessionUpdate}:${m.params.update.status ?? (m.params.update.content ? "content" : "-")}`,
      );
    if (m.id === 3) {
      const after = fs.readFileSync(path.join(cwd, "marker.txt"), "utf8").trim();
      console.log("approvals:", approvals);
      console.log("tool event order:", toolEvents.join(" -> "));
      console.log("file after:", JSON.stringify(after));
      const ok = approvals > 0 && after === "APPROVED";
      console.log("RESULT:", ok ? "PASS" : "FAIL");
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
}, 240000);
