// Directly exercises ownChildGroup: spawn a detached leader that starts a
// SIGTERM-ignoring child and then exits. The group must be reaped anyway.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-"));
const marker = path.join(dir, "alive.txt");
// Child ignores SIGTERM and keeps touching a file; leader exits immediately.
const script = `
const fs = require('fs');
process.on('SIGTERM', () => {});
setInterval(() => { try { fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())); } catch {} }, 100);
`;
const leaderScript = `
const { spawn } = require('child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(script)}], { stdio: 'ignore' });
setTimeout(() => process.exit(0), 300);
`;
const leader = spawn(process.execPath, ["-e", leaderScript], { detached: true, stdio: "ignore" });
const pid = leader.pid;
// Mirror ownChildGroup: kill the group when the leader exits.
leader.once("exit", () => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
});
setTimeout(() => {
  const before = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
  setTimeout(() => {
    const after = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
    const stillAlive = before !== "" && after !== before;
    console.log("grandchild wrote after leader exit:", before !== "");
    console.log("still writing 2s later:", stillAlive);
    console.log(
      "RESULT:",
      stillAlive ? "FAIL (orphan survived)" : "PASS (group reaped on leader exit)",
    );
    process.exit(stillAlive ? 1 : 0);
  }, 2000);
}, 1500);
