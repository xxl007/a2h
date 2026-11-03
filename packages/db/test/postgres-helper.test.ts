// The test helper's container leaves nothing behind (m2-approval-page 6.1,
// small fix): postgres:17 declares a VOLUME, so every container gets an
// anonymous volume, which `docker rm -f` alone leaves on the machine. The
// helper removes it with the container (`-v`), as apps/web's helper does
// since #82. Touches only the container and volume this test starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { skipWithoutDocker, startPostgres } from "./lib/postgres.ts";

function volumeExists(name: string): boolean {
  try {
    execFileSync("docker", ["volume", "inspect", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("stop() removes the container's anonymous volume with it", { skip: skipWithoutDocker() }, async () => {
  const pg = await startPostgres();
  let volumes: string[] = [];
  try {
    const port = new URL(pg.url).port;
    const id = execFileSync("docker", ["ps", "-q", "--filter", `publish=${port}`], { encoding: "utf8" }).trim().split("\n")[0]!;
    assert.ok(id, "the helper's container is running");
    volumes = execFileSync("docker", ["inspect", "-f", "{{range .Mounts}}{{if eq .Type \"volume\"}}{{.Name}} {{end}}{{end}}", id], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
    assert.ok(volumes.length > 0, "postgres:17 gets an anonymous data volume");
  } finally {
    pg.stop();
  }
  const left = volumes.filter(volumeExists);
  // Clean up after a red run, so the failing test itself leaks nothing.
  for (const v of left) execFileSync("docker", ["volume", "rm", v], { stdio: "ignore" });
  assert.deepEqual(left, [], "anonymous volumes left behind by stop()");
});
