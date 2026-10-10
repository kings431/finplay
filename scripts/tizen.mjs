#!/usr/bin/env node
// Samsung TV (Tizen) packages. Nothing here touches the TV; install the .wgt yourself.
//
//   node scripts/tizen.mjs build           Finplay.wgt from a production build (dist-tv/)
//   node scripts/tizen.mjs loader [host]   "Finplay Dev" .wgt that opens http://<host>:1420,
//                                          so `npm run tv` changes show up on the TV live
//
// Signing needs Samsung's Tizen CLI and a certificate profile:
//   TIZEN_PROFILE=<profile name> [TIZEN_CLI=/path/to/tizen]
// Without them the package is left unsigned, which TVs refuse to install.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const [command = "build", hostArg] = process.argv.slice(2);

function config(values) {
  let xml = readFileSync(join(root, "tizen", "config.xml"), "utf8");
  for (const [key, value] of Object.entries({ VERSION: version, ...values })) xml = xml.replaceAll(`{{${key}}}`, value);
  return xml;
}

function lanAddress() {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  return addresses.find((address) => address.startsWith("192.168.")) ?? addresses[0];
}

function tizenCli() {
  if (process.env.TIZEN_CLI) return process.env.TIZEN_CLI;
  const studio = join(homedir(), "tizen-studio", "tools", "ide", "bin", "tizen");
  if (existsSync(studio)) return studio;
  try {
    execFileSync("which", ["tizen"], { stdio: "ignore" });
    return "tizen";
  } catch {
    return null;
  }
}

function pack(dir, name) {
  const out = join(root, "dist-tv-packages");
  mkdirSync(out, { recursive: true });
  const cli = tizenCli();
  const profile = process.env.TIZEN_PROFILE;
  if (cli && profile) {
    execFileSync(cli, ["package", "-t", "wgt", "-s", profile, "-o", out, "--", dir], { stdio: "inherit" });
    console.log(`Signed package written to ${out}`);
    return;
  }
  const target = join(out, `${name}-unsigned.wgt`);
  rmSync(target, { force: true });
  execFileSync("zip", ["-qr", target, "."], { cwd: dir });
  console.log(`Unsigned package: ${target}`);
  console.log(cli ? "Set TIZEN_PROFILE to sign it." : "Install Samsung's Tizen CLI and set TIZEN_PROFILE to sign it.");
}

function icon(dir) {
  copyFileSync(join(root, "src-tauri", "icons", "Square310x310Logo.png"), join(dir, "icon.png"));
}

if (command === "build") {
  execFileSync("npx", ["vite", "build", "--mode", "tv"], { cwd: root, stdio: "inherit" });
  const dir = join(root, "dist-tv");
  writeFileSync(join(dir, "config.xml"), config({ PACKAGE: "FinplayTV0", APP: "Finplay", NAME: "Finplay" }));
  icon(dir);
  pack(dir, "Finplay");
} else if (command === "loader") {
  const host = hostArg ?? lanAddress();
  if (!host) throw new Error("No network address found; pass one: node scripts/tizen.mjs loader 192.168.x.x");
  const url = `http://${host}:1420/`;
  const dir = join(root, "dist-tv-loader");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.xml"), config({ PACKAGE: "FinplayDV0", APP: "FinplayDev", NAME: "Finplay Dev" }));
  icon(dir);
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html>
<html>
  <body style="background:#000;color:#fff;font:28px sans-serif;display:grid;place-items:center;height:100vh;margin:0">
    <p id="status">Connecting to ${url}</p>
    <script>
      // Media keys are registered for the whole app, so they still arrive after the jump.
      var keys = ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop", "MediaFastForward", "MediaRewind", "MediaTrackPrevious", "MediaTrackNext"];
      try { keys.forEach(function (key) { tizen.tvinputdevice.registerKey(key); }); } catch (error) {}
      var url = ${JSON.stringify(url)};
      fetch(url, { mode: "no-cors" })
        .then(function () { location.replace(url); })
        .catch(function () {
          document.getElementById("status").textContent = "Can't reach " + url + ". Is npm run tv running on the Mac?";
        });
      document.addEventListener("keydown", function (event) {
        if (event.keyCode === 10009) tizen.application.getCurrentApplication().exit();
      });
    </script>
  </body>
</html>
`,
  );
  console.log(`Loader opens ${url}`);
  pack(dir, "FinplayDev");
} else {
  console.error(`Unknown command "${command}". Use build or loader.`);
  process.exit(1);
}
