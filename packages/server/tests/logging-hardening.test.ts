import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditWriter, OperationalLogger, RotatingTextWriter, redact, LOG_LEVELS, type Level } from "../src/index.ts";

const fresh = () => mkdtempSync(path.join(tmpdir(), "reach-log-"));
const NOW = new Date("2026-03-04T10:00:00");
const files = (dir: string, base: string) => readdirSync(dir).filter((f) => f.startsWith(base)).map((f) => readFileSync(path.join(dir, f), "utf8")).join("");
const setup = (level: () => Level) => {
  const dir = fresh();
  const settings = () => ({ max_bytes: 1_000_000, retention_days: 5 });
  const logger = new OperationalLogger(new RotatingTextWriter({ dir, base: "reach", settings, now: () => NOW }), () => NOW, level);
  const audit = new AuditWriter(new RotatingTextWriter({ dir, base: "audit", settings, now: () => NOW }), () => NOW);
  return { dir, logger, audit };
};

// Secret-shaped samples are built from parts so no raw secret literal sits in the repository.
const PW = ["hunter", "2-pass"].join("");
const TOKEN = ["tok", "en-abcdef0123456789"].join("");
const KEY = ["sk", "-live-0123456789abcdef"].join("");
const PEM = ["-----BEGIN PRIVATE", " KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE", " KEY-----"].join("");
const SAMPLES: [string, string, string][] = [
  ["password assignment", `login failed password=${PW} for user`, PW],
  ["bearer header", `Authorization: Bearer ${TOKEN} sent`, TOKEN],
  ["api key assignment", `call api_key=${KEY} failed`, KEY],
  ["url credentials", `GET https://admin:${PW}@host.example/x failed`, PW],
  ["url query token", `GET https://host.example/x?access_token=${TOKEN}&a=1`, TOKEN],
  ["private key block", `bad key ${PEM} end`, "MIIEvQIBADANBg"],
  [".env assignment", `read DATABASE_PASSWORD=${PW} SECRET_TOKEN=${TOKEN}`, PW],
];

test("levels: the six are ordered, the default threshold is RUNNING, and lower severities are suppressed", () => {
  assert.deepEqual([...LOG_LEVELS], ["DEBUG", "INFO", "RUNNING", "WARNING", "ERROR", "CRITICAL"]);
  let level: Level = "RUNNING";
  const w = setup(() => level);
  for (const l of LOG_LEVELS) w.logger.log(l, "t", `m-${l}`);
  assert.deepEqual(files(w.dir, "reach").trim().split("\n").map((l) => l.split(" ")[1]), ["RUNNING", "WARNING", "ERROR", "CRITICAL"]);
  level = "CRITICAL"; // live change, no restart
  w.logger.log("ERROR", "t", "dropped");
  w.logger.log("CRITICAL", "t", "kept");
  assert.ok(!files(w.dir, "reach").includes("dropped") && files(w.dir, "reach").includes("kept"));
  level = "DEBUG";
  w.logger.log("DEBUG", "t", "debug-line");
  assert.ok(files(w.dir, "reach").includes("debug-line"));
});

test("audit is never filtered by the operational threshold", () => {
  const w = setup(() => "CRITICAL");
  w.audit.record({ actor: "admin", action: "config_edit", result: "ok" });
  assert.ok(files(w.dir, "audit").includes("action=config_edit"));
  w.logger.log("INFO", "t", "suppressed");
  assert.equal(files(w.dir, "reach"), "");
});

test("redaction: secrets never reach the operational or the audit file at DEBUG; [REDACTED] stays and the context survives", () => {
  const w = setup(() => "DEBUG");
  for (const [name, text, secret] of SAMPLES) {
    w.logger.log("DEBUG", "t", text, "req-1");
    w.audit.record({ actor: "admin", action: "a", target: text, result: text });
    const out = files(w.dir, "reach") + files(w.dir, "audit");
    assert.ok(!out.includes(secret), `${name}: raw secret leaked`);
  }
  const op = files(w.dir, "reach");
  assert.ok(op.includes("[REDACTED]"));
  assert.ok(op.includes("login failed") && op.includes("for user") && op.includes("host.example"), "surrounding context stays visible");
  assert.ok(files(w.dir, "audit").includes("[REDACTED]"));
});

test("redact(): idempotent, keeps non-secret text, and a request id or component cannot smuggle a secret", () => {
  assert.equal(redact("plain text, no secret"), "plain text, no secret");
  assert.equal(redact(redact(`password=${PW}`)), "password=[REDACTED]");
  const w = setup(() => "DEBUG");
  w.logger.log("INFO", `comp password=${PW}`, "m", `id token=${TOKEN}`);
  const out = files(w.dir, "reach");
  assert.ok(!out.includes(PW) && !out.includes(TOKEN));
});

test("safe context: a Machine UUID, friendly name and build appear when given and are redacted like everything else", () => {
  const w = setup(() => "DEBUG");
  w.logger.log("INFO", "connections", "client connected client_id=laptop machine_uuid=3eb1bd43-9947-eb76-2998-e566ccc2e099 display_name=Laptop client_build=b1");
  assert.ok(files(w.dir, "reach").includes("machine_uuid=3eb1bd43-9947-eb76-2998-e566ccc2e099 display_name=Laptop client_build=b1"));
});

test("config: the level is one of the six, defaults to RUNNING, survives a partial logging edit and rejects anything else", async () => {
  const { ServerConfigStore, ConfigError, DEFAULT_LOGGING } = await import("../src/index.ts");
  assert.equal(DEFAULT_LOGGING.level, "RUNNING");
  const { startRuntime } = await import("./runtime-fixture.ts");
  const rt = await startRuntime();
  assert.equal(rt.config.loggingSettings().level, "RUNNING");
  const clients = rt.config.editableView().clients.map((c) => ({ client_id: c.client_id, display_name: c.display_name, enabled: c.enabled, projects: c.projects }));
  rt.config.applyEdit({ logging: { level: "DEBUG" }, clients });
  assert.deepEqual(rt.config.loggingSettings(), { ...DEFAULT_LOGGING, level: "DEBUG" }, "a partial edit keeps size and retention");
  rt.config.applyEdit({ logging: { max_bytes: 4096 }, clients });
  assert.equal(rt.config.loggingSettings().level, "DEBUG", "an edit without a level keeps it");
  assert.throws(() => rt.config.applyEdit({ logging: { level: "TRACE" }, clients }), ConfigError);
  assert.equal(typeof ServerConfigStore, "function");
  await rt.close();
});
