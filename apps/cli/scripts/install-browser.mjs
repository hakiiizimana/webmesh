import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function commandExists(command) {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasSystemBrowser() {
  if (platform() === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ].some(existsSync);
  }
  if (platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const paths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    if (localAppData) paths.unshift(`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`);
    return paths.some(existsSync);
  }
  return ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"].some(commandExists);
}

if (hasSystemBrowser()) {
  console.log("webmesh: using the Chrome or Chromium already installed on this machine.");
} else {
  const agentBrowser = require.resolve("agent-browser/bin/agent-browser.js");
  console.log("webmesh: no Chrome or Chromium found; downloading Chromium for browser commands.");
  execFileSync(process.execPath, [agentBrowser, "install"], { stdio: "inherit" });
}
