import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sig2-"));
const scan = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("t3-agy-"));
const before = new Set(scan());
const child = spawn(process.execPath, ["dist/bin.mjs", "agy-acp"], {
  env: { ...process.env, T3_AGY_REQUIRE_APPROVAL: "0" },
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "";
let promptSent = 0;
const send = (m) => {
  try {
    child.stdin.write(JSON.stringify(m) + "\n");
  } catch {}
};
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
      console.log("init ok");
      send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd } });
    } else if (m.id === 2 && m.result) {
      console.log("session ok");
      promptSent = Date.now();
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: m.result.sessionId,
          _meta: { t3: { epoch: 0 } },
          prompt: [{ type: "text", text: "Count slowly from 1 to 30." }],
        },
      });
    }
  }
});
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
const poll = setInterval(() => {
  const now = scan().filter((n) => !before.has(n));
  if (now.length) {
    console.log("saw dirs:", now.length, now.map((n) => n.slice(0, 18)).join(","));
    clearInterval(poll);
    child.kill("SIGTERM");
    setTimeout(() => {
      const after = scan().filter((n) => !before.has(n));
      console.log("after SIGTERM:", after.length);
      console.log(
        "RESULT:",
        after.length === 0 ? "PASS (cleaned on signal)" : "FAIL (leaked: " + after.join(",") + ")",
      );
      process.exit(after.length === 0 ? 0 : 1);
    }, 2500);
  }
}, 200);
setTimeout(() => {
  console.log("no dirs after 40s; promptSent=", promptSent > 0);
  process.exit(2);
}, 40000);
