// ---------------------------------------------------------------------------
// Token Radar — entry program.
//
// One sealed snapshot in, one hand-in out: board.json, data.js, the dashboard
// and screenshots copied from this repository, and finally dossier.json built
// from those files by the vendored make.fun library. Every refusal goes to
// stderr with a distinct exit code; nothing here consults the clock, randomness
// or the environment beyond the documented output-dir variable, so the same
// snapshot always produces byte-identical outputs.
//
// Node 22, standard library only. Run: node main.ts [--input <file|dir>]
// [--output <dir>].
// ---------------------------------------------------------------------------

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boardIssue, buildBoard, buildPayload, dataScript, parseSnapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

/** The repository root: dashboard/ and screenshots/ are copied from here, not from cwd. */
const REPO = dirname(fileURLToPath(import.meta.url));

/** A screenshot name the dossier accepts (same rule as vendor PLAIN_NAME). */
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Report a refusal on stderr and stop with the given exit code. */
function fail(message: string, code: number): never {
  process.stderr.write(message + "\n");
  process.exit(code);
}

/** Parse --input/--output in both "--name value" and "--name=value" forms. */
function parseArgs(argv: string[]): { input: string; output: string } {
  let input = "/input";
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name !== "--input" && name !== "--output") fail(`unknown argument: ${arg}`, 2);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "") fail(`${name} needs a value`, 2);
    if (name === "--input") input = value;
    else output = value;
  }
  return { input, output };
}

/**
 * Copy regular files from src into dst, recursively, skipping every name that
 * starts with a dot (links and other specials are never taken for files).
 * Entries are visited in name order; returns the copied paths relative to src.
 */
function copyTree(src: string, dst: string): string[] {
  const copied: string[] = [];
  const walk = (rel: string): void => {
    const entries = readdirSync(join(src, rel), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile()) {
        const target = join(dst, p);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(src, p), target);
        copied.push(p);
      }
    }
  };
  walk("");
  return copied;
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));

  // Resolve the snapshot: a .json path is the file itself, else a directory.
  const snapshotPath = input.endsWith(".json") ? input : join(input, "snapshot.json");
  if (!existsSync(snapshotPath)) fail(`snapshot not found: ${snapshotPath}`, 2);
  let snapshot: ReturnType<typeof parseSnapshot>;
  try {
    snapshot = parseSnapshot(readFileSync(snapshotPath, "utf8"));
  } catch (err) {
    fail(`cannot parse snapshot ${snapshotPath}: ${(err as Error).message}`, 2);
  }

  // Refuse to hand in a board the gate would refuse.
  const board = buildBoard(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) fail(`board refused: ${issue}`, 1);

  const out = resolve(output);
  mkdirSync(out, { recursive: true });
  const written = ["board.json", "data.js"];
  writeFileSync(join(out, "board.json"), JSON.stringify({ rows: board }) + "\n");
  // data.js sits at the output root: the dashboard page loads ../data.js.
  writeFileSync(join(out, "data.js"), dataScript(buildPayload(snapshot, board)));

  for (const dir of ["dashboard", "screenshots"] as const) {
    const src = join(REPO, dir);
    if (!existsSync(src)) fail(`missing ${dir}/ directory in the repository`, 1);
    for (const rel of copyTree(src, join(out, dir))) written.push(`${dir}/${rel}`);
  }

  // Validate what was actually handed in: at least 3 images, plain names only.
  const shots = readdirSync(join(out, "screenshots"), { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  if (shots.length < 3) fail(`screenshots: ${shots.length} images, at least 3 required`, 1);
  for (const name of shots) {
    if (!SHOT_NAME.test(name)) fail(`screenshots: name "${name}" is not a plain dossier name`, 1);
  }

  // The dossier is built from every other output file, so it is written last.
  let dossier: Uint8Array;
  try {
    dossier = buildDossier(out, {
      text_max_bytes: 65536,
      screenshots: { max: 4, max_bytes: 524288 },
      dashboard: { max_files: 400, max_bytes: 4194304 },
    });
  } catch (err) {
    fail(`dossier refused: ${(err as Error).message}`, 1);
  }
  writeFileSync(join(out, "dossier.json"), dossier);
  written.push("dossier.json");

  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ` +
      `${snapshot.watchlist.length} on the watchlist, ${board.length} board rows\n` +
      `wrote: ${written.join(", ")}\n`,
  );
}

main();