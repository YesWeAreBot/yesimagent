import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const { workspaces } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  workspaces: string[];
};

// ponytail: one-level "dir/*" patterns only, which is all this repo declares.
// Order comes from the workspaces array then alphabetical, so a package always
// follows the packages it depends on.
const packages = workspaces
  .map((pattern) => {
    const [dir, glob] = pattern.split("/");
    if (glob !== "*") throw new Error(`unsupported workspace pattern: ${pattern}`);
    return path.join(root, dir);
  })
  .flatMap((dir) =>
    readdirSync(dir)
      .sort()
      .map((name) => path.join(dir, name)),
  )
  .filter((dir) => statSync(dir).isDirectory());

const destination = mkdtempSync(path.join(tmpdir(), "yesimagent-publish-"));

try {
  for (const dir of packages) {
    // bun rewrites `workspace:*` to a concrete version; npm pack/publish do not.
    const tarball = execFileSync("bun", ["pm", "pack", "--destination", destination, "--quiet"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    execFileSync("npm", ["publish", ...(dryRun ? ["--dry-run"] : []), tarball], { stdio: "inherit" });
  }
} finally {
  rmSync(destination, { recursive: true, force: true });
}
