// Sets the app version everywhere it appears: node scripts/version.mjs 0.2.0
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("Usage: node scripts/version.mjs <major.minor.patch>");
  process.exit(1);
}

const edit = (path, pattern, replacement) => {
  const before = readFileSync(path, "utf8");
  if (!pattern.test(before)) throw new Error(`No version found in ${path}`);
  writeFileSync(path, before.replace(pattern, replacement));
};

edit("package.json", /"version": "[^"]+"/, `"version": "${version}"`);
edit("src-tauri/tauri.conf.json", /"version": "[^"]+"/, `"version": "${version}"`);
edit("src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${version}"`);
edit("src/jellyfin.ts", /const VERSION = "[^"]+"/, `const VERSION = "${version}"`);
console.log(`Finplay is now ${version}. Commit, then: git tag v${version} && git push && git push origin v${version}`);
