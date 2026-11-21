// The System screen's read model: only facts this process can know cheaply and safely (its own build, uptime, runtime, and the free space
// of the directories it was configured with). Anything it cannot know (tunnel, host inventory, update status) is simply absent here,
// and the screen shows it as not exposed. Never a secret and never file contents.
import { statfsSync } from "node:fs";
import os from "node:os";
import type { HealthSnapshot } from "./health.ts";

export type StorageFacts = { name: string; path: string; total_bytes: number; free_bytes: number };

/** Space of one configured directory, or null when it cannot be read. */
export function storageOf(name: string, dir: string): StorageFacts | null {
  try {
    const fs = statfsSync(dir);
    return { name, path: dir, total_bytes: fs.blocks * fs.bsize, free_bytes: fs.bavail * fs.bsize };
  } catch {
    return null;
  }
}

export function systemView(health: HealthSnapshot, directories: { name: string; dir: string }[]) {
  return {
    server: { build: health.server_build, commit: health.repository_commit, uptime_seconds: health.uptime_seconds, config_active: health.config_active },
    storage: directories.flatMap(({ name, dir }) => storageOf(name, dir) ?? []),
    services: { http: health.status === "ok", websocket: health.config_active, connected_clients: health.clients.connected },
    environment: { node: process.version, platform: `${process.platform} ${process.arch}`, cpus: os.availableParallelism(), memory_bytes: os.totalmem() },
  };
}
