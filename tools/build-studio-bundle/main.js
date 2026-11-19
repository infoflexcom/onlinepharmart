"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// buildstudio/main.ts
var import_electron = require("electron");
var import_node_child_process2 = require("node:child_process");
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var import_node_os = require("node:os");

// buildstudio/src/build-steps.ts
var NPM = "npm";
var BUILD_STEPS = [
  {
    id: "check-tools",
    title: "Checking this computer",
    detail: "Making sure the tools a build needs are installed.",
    command: NPM,
    args: ["--version"],
    weight: 1,
    produces: []
  },
  {
    id: "install-dependencies",
    title: "Installing project files",
    detail: "Copying in the libraries the application uses. This is the slow one the first time.",
    command: NPM,
    args: ["ci", "--no-audit", "--no-fund"],
    weight: 30,
    produces: []
  },
  {
    // Before the installer data is generated, because the digest it fetches is written into that data. Running it
    // after would produce an installer pinned to the previous digest -- or to the all-zeros placeholder.
    id: "fetch-prerequisite",
    title: "Fetching the Microsoft component",
    detail: "Downloading the official Visual C++ runtime, checking Microsoft signed it, and recording its fingerprint.",
    command: NPM,
    args: ["run", "release:prerequisite"],
    weight: 4,
    produces: []
  },
  {
    id: "generate-installer-data",
    title: "Preparing the installer data",
    detail: "Writing the currency list and password hash the installer uses.",
    command: NPM,
    args: ["run", "installer:script"],
    weight: 2,
    produces: []
  },
  {
    id: "typecheck",
    title: "Checking the code",
    detail: "Looking for mistakes before anything is packaged.",
    command: NPM,
    args: ["run", "typecheck"],
    weight: 8,
    produces: []
  },
  {
    id: "test",
    title: "Running the tests",
    detail: "Checking the shop, the money and the licence behave correctly.",
    command: NPM,
    args: ["test", "--", "--reporter=dot"],
    weight: 20,
    produces: []
  },
  {
    id: "build-desktop",
    title: "Building the desktop app",
    detail: "Compiling the application that runs on the shop computer.",
    command: NPM,
    args: ["run", "build"],
    weight: 14,
    produces: []
  },
  {
    id: "build-mobile",
    title: "Building the Admin mobile app",
    detail: "Building the phone app that gets bundled inside the desktop app.",
    command: NPM,
    args: ["run", "build:mobile"],
    weight: 5,
    produces: []
  },
  {
    id: "build-installer-online",
    title: "Building Infoflex Setup.exe",
    detail: "The installer that downloads a missing component from Microsoft.",
    command: NPM,
    args: ["run", "installer:online"],
    weight: 10,
    produces: [{ path: "dist/online/Infoflex Setup.exe", title: "Infoflex Setup.exe" }]
  },
  {
    id: "build-installer-offline",
    title: "Building Infoflex Setup Offline.exe",
    detail: "The installer for shops with no internet, with everything inside it.",
    command: NPM,
    args: ["run", "installer:offline"],
    weight: 10,
    produces: [{ path: "dist/offline/Infoflex Setup Offline.exe", title: "Infoflex Setup Offline.exe" }]
  },
  {
    id: "build-cloud-package",
    title: "Building the Vendor Cloud package",
    detail: "Packing the licence server and its deployment guide for upload.",
    command: NPM,
    args: ["run", "cloud:package"],
    weight: 6,
    produces: [{ path: "dist/cloud/infoflex-vendor-cloud.zip", title: "Vendor Cloud package" }]
  },
  {
    id: "verify-artefacts",
    title: "Checking the result",
    detail: "Opening each built file and recording its size and fingerprint.",
    command: NPM,
    args: ["run", "artefacts:verify"],
    weight: 2,
    produces: []
  }
];
var STEP_GROUPS = {
  "install-project-files": ["install-dependencies"],
  "run-tests": ["typecheck", "test"],
  "test-run-app": ["build-desktop"],
  "build-mobile-app": ["generate-installer-data", "build-mobile"],
  "build-installers": ["fetch-prerequisite", "generate-installer-data", "build-desktop", "build-mobile", "build-installer-online", "build-installer-offline", "verify-artefacts"],
  "build-cloud-package": ["build-cloud-package"],
  "do-everything": BUILD_STEPS.map((step) => step.id)
};
function findStep(id) {
  const step = BUILD_STEPS.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`There is no build step called "${id}".`);
  return step;
}
function stepsForGroup(group) {
  const ids = STEP_GROUPS[group];
  if (!ids) throw new Error(`"${group}" is not a Build Studio action.`);
  return ids.map(findStep);
}
function totalWeight(steps) {
  return steps.reduce((sum, step) => sum + step.weight, 0);
}
function explainFailure(input) {
  const text = input.output;
  const has = (pattern) => pattern.test(text);
  if (has(/EACCES|EPERM|EBUSY|being used by another process/iu)) {
    return {
      cause: "A file Build Studio needs is being used by another program.",
      fixes: [
        "Close Infoflex and Build Studio, then press Retry.",
        "If the project folder is inside OneDrive or Dropbox, pause the sync and try again."
      ]
    };
  }
  if (has(/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo|network|ECONNREFUSED/iu)) {
    return {
      cause: "Build Studio could not reach the internet, which it needs to fetch the project libraries.",
      fixes: [
        "Check this computer is online, then press Retry.",
        "If this computer uses a company proxy, ask IT to allow npm and nsis downloads."
      ]
    };
  }
  if (has(/unable to verify the first certificate|SELF_SIGNED_CERT|CERT_HAS_EXPIRED/iu)) {
    return {
      cause: "Something on this network is intercepting secure connections, so downloads cannot be verified.",
      fixes: [
        "Ask IT whether a proxy inspects HTTPS traffic, and whether it can be turned off for this computer.",
        "Try a different network, such as a phone hotspot, then press Retry."
      ]
    };
  }
  if (has(/gyp|MSBuild|vcbuild|node-gyp|Visual Studio/iu)) {
    return {
      cause: "The compiled database module could not be built because the C++ build tools are missing or incomplete.",
      fixes: [
        'Press "Check my computer", then install the Visual Studio Build Tools it offers.',
        'In the installer, make sure "Desktop development with C++" is ticked.'
      ]
    };
  }
  if (has(/makensis|nsis/iu)) {
    return {
      cause: "The installer maker could not be downloaded, so the installers were not produced.",
      fixes: [
        "Check this computer is online and press Retry. The installer maker is downloaded once and kept.",
        'If it keeps failing, the Vendor Cloud package and the app can still be built: press "Build project files" instead.'
      ]
    };
  }
  if (has(/ENOSPC|no space left/iu)) {
    return {
      cause: "This computer has run out of disk space.",
      fixes: [
        "Free at least 12 GB, or choose another drive for the build output in Settings, then press Retry."
      ]
    };
  }
  if (input.step.id === "test" && input.exitCode !== 0) {
    return {
      cause: "One of the automatic tests found a problem, so Build Studio stopped rather than packaging a broken app.",
      fixes: [
        'Press "Copy error details" and send them to the person who maintains Infoflex.',
        "The list of failing tests is in the details below; the first one is usually the cause."
      ]
    };
  }
  return {
    cause: `${input.step.title} stopped with an error. The details are below.`,
    fixes: [
      "Press Retry once: a temporary problem such as a dropped connection often clears.",
      'If it happens again, press "Copy error details" and send them for support.'
    ]
  };
}
function redactSecrets(text, secrets) {
  let result = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    result = result.split(secret).join("[redacted]");
    const pattern = new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

// buildstudio/src/prerequisites.ts
var OFFICIAL_DOWNLOAD_HOSTS = [
  "nodejs.org",
  "aka.ms",
  "download.microsoft.com",
  "download.visualstudio.microsoft.com",
  "www.python.org",
  "python.org"
];
var TOOLS = [
  {
    id: "nodejs",
    title: "Node.js 20 or newer",
    why: "Runs the application and its build scripts.",
    required: true,
    acquisition: {
      kind: "download",
      page: "https://nodejs.org/en/download",
      url: "https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi",
      publisher: "OpenJS Foundation",
      silentArguments: ["/qn", "/norestart"],
      approximateSizeMb: 30
    },
    probe: { command: "node", args: ["--version"], minimum: "v20.0.0" }
  },
  {
    id: "npm",
    title: "npm",
    why: "Installs the project dependencies. It comes with Node.js, so a missing npm means a broken Node install.",
    required: true,
    acquisition: { kind: "installed-with", tool: "nodejs" },
    probe: { command: "npm", args: ["--version"] }
  },
  {
    id: "vs-build-tools",
    title: 'Visual Studio Build Tools with "Desktop development with C++"',
    why: "Compiles the native database module. Without it the app builds but will not start on a customer PC.",
    required: true,
    acquisition: {
      kind: "download",
      page: "https://visualstudio.microsoft.com/visual-cpp-build-tools/",
      // The bootstrapper downloads the real payload itself, from Microsoft.
      url: "https://aka.ms/vs/17/release/vs_buildtools.exe",
      publisher: "Microsoft Corporation",
      // --quiet with a workload: no UI at all. --wait would block; Build Studio watches the process instead.
      silentArguments: [
        "--quiet",
        "--wait",
        "--norestart",
        "--nocache",
        "--add",
        "Microsoft.VisualStudio.Workload.VCTools",
        "--includeRecommended"
      ],
      approximateSizeMb: 3500
    },
    probe: null
  },
  {
    id: "python",
    title: "Python 3",
    why: "A few of the build tools prefer it. If it is missing the build uses a bundled alternative; install it only if a build asks.",
    required: false,
    acquisition: {
      kind: "download",
      page: "https://www.python.org/downloads/windows/",
      url: "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe",
      publisher: "Python Software Foundation",
      silentArguments: ["/quiet", "InstallAllUsers=1", "PrependPath=1", "Include_test=0"],
      approximateSizeMb: 25
    },
    probe: { command: "python", args: ["--version"] }
  },
  {
    id: "git",
    title: "Git",
    why: "Only needed to fetch a project from a source repository. A project folder copied onto this computer does not need it.",
    required: false,
    acquisition: {
      kind: "download",
      page: "https://git-scm.com/download/win",
      url: "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe",
      publisher: "Johannes Schindelin",
      silentArguments: ["/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-"],
      approximateSizeMb: 60
    },
    probe: { command: "git", args: ["--version"] }
  },
  {
    id: "nsis",
    title: "NSIS (the installer maker)",
    why: "Turns the installer script into Infoflex Setup.exe. It comes with the project, so nothing is downloaded.",
    required: false,
    acquisition: {
      // electron-builder ships its own makensis; this is why the check is "is it available", not "install NSIS".
      kind: "bundled",
      note: "Bundled with the project. Build Studio does not download it."
    },
    probe: null
  },
  {
    id: "internet",
    title: "Internet connection",
    why: "Needed to install missing tools and to fetch the project dependencies the first time.",
    required: false,
    acquisition: { kind: "manual", reason: "Nothing to install: this is the connection itself." },
    probe: null
  },
  {
    id: "disk",
    title: "Free disk space",
    why: "About 12 GB is needed: the build tools, the project, and two installers.",
    required: true,
    acquisition: { kind: "manual", reason: "Free up space on this computer, or choose another drive for the build output." },
    probe: null
  }
];
var REQUIRED_DISK_BYTES = 12n * 1024n * 1024n * 1024n;
function findTool(id) {
  return TOOLS.find((tool) => tool.id === id) ?? null;
}
function planDownload(id, options = {}) {
  const tool = findTool(id);
  if (!tool) return { ok: false, reason: `There is no tool called "${id}".` };
  const acquisition = tool.acquisition;
  if (acquisition.kind === "bundled") {
    return { ok: false, reason: `${tool.title} is included with the project, so there is nothing to download.` };
  }
  if (acquisition.kind === "installed-with") {
    return { ok: false, reason: `${tool.title} comes with ${findTool(acquisition.tool)?.title ?? acquisition.tool}. Install that instead.` };
  }
  if (acquisition.kind === "manual") {
    return { ok: false, reason: acquisition.reason };
  }
  const hosts = options.allowlistedHosts ?? OFFICIAL_DOWNLOAD_HOSTS;
  let host;
  try {
    const parsed = new URL(acquisition.url);
    if (parsed.protocol !== "https:") {
      return { ok: false, reason: `${tool.title} would be downloaded over an insecure connection, so Build Studio will not do it.`, page: acquisition.page };
    }
    host = parsed.hostname;
  } catch {
    return { ok: false, reason: `${tool.title} has no valid download address.`, page: acquisition.page };
  }
  if (!hosts.includes(host)) {
    return {
      ok: false,
      reason: `${tool.title} would be downloaded from ${host}, which is not an official address. Build Studio will not do that.`,
      page: acquisition.page
    };
  }
  return {
    ok: true,
    plan: {
      tool: tool.id,
      url: acquisition.url,
      publisher: acquisition.publisher,
      silentArguments: [...acquisition.silentArguments]
    }
  };
}

// buildstudio/src/system-check.ts
var RANK = { blocked: 0, "missing-installable": 1, ok: 2 };
function compareVersions(left, right) {
  const parse = (value) => value.replace(/^v/iu, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
function evaluateProbe(input) {
  const { tool, found, versionOutput, canInstall } = input;
  const version = versionOutput ? versionOutput.trim().split(/\s+/u).at(-1) ?? null : null;
  const base = { id: tool.id, title: tool.title, required: tool.required, version };
  if (!found) {
    if (tool.required && !canInstall) {
      return {
        ...base,
        state: "blocked",
        rank: RANK.blocked,
        message: `${tool.title} is missing and Build Studio cannot install it for you. ${tool.acquisition.kind === "manual" ? tool.acquisition.reason : "Install it from the official website, then press Check again."}`
      };
    }
    return {
      ...base,
      state: "missing-installable",
      rank: RANK["missing-installable"],
      message: tool.required ? `${tool.title} is missing. Press "Install everything that's missing".` : `${tool.title} is missing. It is not needed for a normal build.`
    };
  }
  const minimum = tool.probe?.minimum;
  if (minimum && version && compareVersions(version, minimum) < 0) {
    return {
      ...base,
      state: tool.required && !canInstall ? "blocked" : "missing-installable",
      rank: tool.required && !canInstall ? RANK.blocked : RANK["missing-installable"],
      message: `${tool.title} is version ${version}, which is too old. ${minimum} or newer is needed.`
    };
  }
  return { ...base, state: "ok", rank: RANK.ok, message: `${tool.title} is ready${version ? ` (version ${version})` : ""}.` };
}
function sortChecks(checks) {
  return [...checks].sort((left, right) => left.rank - right.rank);
}
function summarise(checks) {
  const blocked = checks.filter((check) => check.state === "blocked");
  const installable = checks.filter((check) => check.state === "missing-installable" && check.required);
  if (blocked.length > 0) {
    return {
      ready: false,
      headline: `${blocked.length === 1 ? "One thing needs" : `${blocked.length} things need`} your attention before a build can start.`
    };
  }
  if (installable.length > 0) {
    return {
      ready: false,
      headline: `${installable.length === 1 ? "One tool is" : `${installable.length} tools are`} missing. Press "Install everything that's missing".`
    };
  }
  return { ready: true, headline: "This computer is ready to build." };
}
async function runSystemCheck(options) {
  const checks = [];
  for (const tool of TOOLS) {
    if (tool.id === "disk") {
      const free = await options.freeDiskBytes();
      const enough = free >= REQUIRED_DISK_BYTES;
      checks.push({
        id: tool.id,
        title: tool.title,
        required: true,
        version: null,
        state: enough ? "ok" : "blocked",
        rank: enough ? RANK.ok : RANK.blocked,
        message: enough ? `There is ${formatGigabytes(free)} GB free, which is plenty.` : `There is only ${formatGigabytes(free)} GB free. Free up at least 12 GB, or choose another drive in Settings.`
      });
      continue;
    }
    if (tool.id === "internet") {
      checks.push({
        id: tool.id,
        title: tool.title,
        required: false,
        version: null,
        state: "ok",
        rank: RANK.ok,
        message: "Checked when needed. Build Studio tells you if a download fails."
      });
      continue;
    }
    if (tool.id === "nsis") {
      checks.push({
        id: tool.id,
        title: tool.title,
        required: false,
        version: null,
        state: "ok",
        rank: RANK.ok,
        message: tool.acquisition.kind === "bundled" ? tool.acquisition.note : "Ready."
      });
      continue;
    }
    if (!tool.probe) {
      const installed = options.probePartialInstall ? await options.probePartialInstall(tool) : null;
      if (installed === true) {
        checks.push({
          id: tool.id,
          title: tool.title,
          required: tool.required,
          version: null,
          state: "ok",
          rank: RANK.ok,
          message: `${tool.title} is installed.`
        });
      } else if (installed === false) {
        const state = options.canInstall(tool) ? "missing-installable" : "blocked";
        checks.push({
          id: tool.id,
          title: tool.title,
          required: tool.required,
          version: null,
          state,
          rank: RANK[state],
          message: options.canInstall(tool) ? `${tool.title} is not installed. Press "Install everything that's missing".` : `${tool.title} is not installed and cannot be installed automatically.`
        });
      } else {
        checks.push({
          id: tool.id,
          title: tool.title,
          required: false,
          version: null,
          state: "ok",
          rank: RANK.ok,
          message: `${tool.title} is checked while building, because it has no version command of its own.`
        });
      }
      continue;
    }
    const output = await options.probe(tool);
    checks.push(evaluateProbe({ tool, found: output !== null, versionOutput: output, canInstall: options.canInstall(tool) }));
  }
  const sorted = sortChecks(checks);
  return { checks: sorted, ...summarise(sorted) };
}
function formatGigabytes(bytes) {
  return (Number(bytes) / 1024 ** 3).toFixed(1);
}

// buildstudio/src/runner.ts
var import_node_child_process = require("node:child_process");
function resolveExecutable(command, platform = process.platform) {
  if (platform === "win32" && command === "npm") return "npm.cmd";
  return command;
}
function createLineSplitter(onLine) {
  let buffer = "";
  return (chunk, flush = false) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (part.trim()) onLine(part);
    }
    if (flush && buffer.trim()) {
      onLine(buffer);
      buffer = "";
    }
  };
}
function runCommand(options) {
  const executable = resolveExecutable(options.command);
  let cancelled = false;
  let child = null;
  let idleTimer = null;
  let resolveDone = () => {
  };
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdle = () => {
    clearIdle();
    if (!options.idleNotice || !options.idleNoticeMs) return;
    const started = Date.now();
    idleTimer = setTimeout(() => options.idleNotice?.(Date.now() - started), options.idleNoticeMs);
    idleTimer.unref?.();
  };
  try {
    child = (0, import_node_child_process.spawn)(executable, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      // The three lines that keep a console window from appearing on Windows.
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onLine(`Build Studio could not start ${executable}: ${message}`, "stderr");
    resolveDone({ exitCode: null, cancelled: false });
    options.onDone({ exitCode: null, cancelled: false });
    return { cancel: () => {
    }, done };
  }
  armIdle();
  const forward = (stream) => createLineSplitter((line) => {
    armIdle();
    options.onLine(redactSecrets(line, options.secrets), stream);
  });
  const out = forward("stdout");
  const err = forward("stderr");
  child.stdout?.setEncoding("utf8").on("data", (chunk) => out(chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk) => err(chunk));
  const finish = (exitCode) => {
    clearIdle();
    out("", true);
    err("", true);
    const result = { exitCode, cancelled };
    resolveDone(result);
    options.onDone(result);
  };
  child.on("error", (error) => {
    options.onLine(`Build Studio could not run ${executable}: ${error.message}`, "stderr");
    finish(null);
  });
  child.on("close", (code) => finish(code));
  return {
    done,
    cancel: () => {
      if (!child || cancelled) return;
      cancelled = true;
      clearIdle();
      options.onLine("Cancelling\u2026", "stdout");
      killTree(child);
    }
  };
}
function killTree(child, options = {}) {
  if (!child.pid) return;
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawn ?? import_node_child_process.spawn;
  if (platform === "win32") {
    try {
      spawnProcess("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    } catch {
    }
  }
  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }, 5e3).unref?.();
  } catch {
  }
}

// buildstudio/src/settings-store.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// src/currency/catalog.ts
var western = { thousandsSeparator: ",", decimalSeparator: "." };
var european = { thousandsSeparator: ".", decimalSeparator: "," };
var francZone = { thousandsSeparator: "\u202F", decimalSeparator: "," };
var CURRENCIES = [
  { code: "NGN", name: "Nigerian naira", symbol: "\u20A6", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "USD", name: "US dollar", symbol: "$", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "EUR", name: "Euro", symbol: "\u20AC", decimalPlaces: 2, symbolPosition: "after", ...european, kind: "iso" },
  { code: "GBP", name: "British pound", symbol: "\xA3", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "GHS", name: "Ghanaian cedi", symbol: "GH\u20B5", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "KES", name: "Kenyan shilling", symbol: "KSh", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "ZAR", name: "South African rand", symbol: "R", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "XOF", name: "West African CFA franc", symbol: "CFA", decimalPlaces: 0, symbolPosition: "after", ...francZone, kind: "iso" },
  { code: "XAF", name: "Central African CFA franc", symbol: "FCFA", decimalPlaces: 0, symbolPosition: "after", ...francZone, kind: "iso" },
  { code: "UGX", name: "Ugandan shilling", symbol: "USh", decimalPlaces: 0, symbolPosition: "before", ...western, kind: "iso" },
  { code: "TZS", name: "Tanzanian shilling", symbol: "TSh", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "RWF", name: "Rwandan franc", symbol: "FRw", decimalPlaces: 0, symbolPosition: "before", ...western, kind: "iso" },
  { code: "ETB", name: "Ethiopian birr", symbol: "Br", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "EGP", name: "Egyptian pound", symbol: "E\xA3", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "MAD", name: "Moroccan dirham", symbol: "\u062F.\u0645.", decimalPlaces: 2, symbolPosition: "after", ...western, kind: "iso" },
  { code: "TND", name: "Tunisian dinar", symbol: "\u062F.\u062A", decimalPlaces: 3, symbolPosition: "after", ...western, kind: "iso" },
  { code: "DZD", name: "Algerian dinar", symbol: "\u062F.\u062C", decimalPlaces: 2, symbolPosition: "after", ...western, kind: "iso" },
  { code: "ZMW", name: "Zambian kwacha", symbol: "ZK", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "MWK", name: "Malawian kwacha", symbol: "MK", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "BWP", name: "Botswana pula", symbol: "P", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "NAD", name: "Namibian dollar", symbol: "N$", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "MZN", name: "Mozambican metical", symbol: "MT", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "AOA", name: "Angolan kwanza", symbol: "Kz", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "GMD", name: "Gambian dalasi", symbol: "D", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "SLE", name: "Sierra Leonean leone", symbol: "Le", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "LRD", name: "Liberian dollar", symbol: "L$", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "CDF", name: "Congolese franc", symbol: "FC", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "SDG", name: "Sudanese pound", symbol: "\u062C.\u0633.", decimalPlaces: 2, symbolPosition: "after", ...western, kind: "iso" },
  { code: "SSP", name: "South Sudanese pound", symbol: "SSP", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "CAD", name: "Canadian dollar", symbol: "C$", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "AUD", name: "Australian dollar", symbol: "A$", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "NZD", name: "New Zealand dollar", symbol: "NZ$", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "INR", name: "Indian rupee", symbol: "\u20B9", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "PKR", name: "Pakistani rupee", symbol: "\u20A8", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "BDT", name: "Bangladeshi taka", symbol: "\u09F3", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "LKR", name: "Sri Lankan rupee", symbol: "Rs", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "AED", name: "UAE dirham", symbol: "\u062F.\u0625", decimalPlaces: 2, symbolPosition: "after", ...western, kind: "iso" },
  { code: "SAR", name: "Saudi riyal", symbol: "\u0631.\u0633", decimalPlaces: 2, symbolPosition: "after", ...western, kind: "iso" },
  { code: "QAR", name: "Qatari riyal", symbol: "\u0631.\u0642", decimalPlaces: 2, symbolPosition: "after", ...western, kind: "iso" },
  { code: "KWD", name: "Kuwaiti dinar", symbol: "\u062F.\u0643", decimalPlaces: 3, symbolPosition: "after", ...western, kind: "iso" },
  { code: "BHD", name: "Bahraini dinar", symbol: "\u062F.\u0628", decimalPlaces: 3, symbolPosition: "after", ...western, kind: "iso" },
  { code: "OMR", name: "Omani rial", symbol: "\u0631.\u0639.", decimalPlaces: 3, symbolPosition: "after", ...western, kind: "iso" },
  { code: "JOD", name: "Jordanian dinar", symbol: "\u062F.\u0627", decimalPlaces: 3, symbolPosition: "after", ...western, kind: "iso" },
  { code: "TRY", name: "Turkish lira", symbol: "\u20BA", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "CNY", name: "Chinese yuan", symbol: "\xA5", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "JPY", name: "Japanese yen", symbol: "\xA5", decimalPlaces: 0, symbolPosition: "before", ...western, kind: "iso" },
  { code: "KRW", name: "South Korean won", symbol: "\u20A9", decimalPlaces: 0, symbolPosition: "before", ...western, kind: "iso" },
  { code: "SGD", name: "Singapore dollar", symbol: "S$", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "MYR", name: "Malaysian ringgit", symbol: "RM", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "IDR", name: "Indonesian rupiah", symbol: "Rp", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "PHP", name: "Philippine peso", symbol: "\u20B1", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "THB", name: "Thai baht", symbol: "\u0E3F", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" },
  { code: "BRL", name: "Brazilian real", symbol: "R$", decimalPlaces: 2, symbolPosition: "before", ...european, kind: "iso" },
  { code: "MXN", name: "Mexican peso", symbol: "$", decimalPlaces: 2, symbolPosition: "before", ...western, kind: "iso" }
];
var currencyByCode = new Map(CURRENCIES.map((currency) => [currency.code, currency]));
function getCurrency(code) {
  return currencyByCode.get(code.toUpperCase());
}

// installer/src/download-allowlist.ts
var ALLOWLISTED_COMPONENTS = [
  {
    id: "vcredist-x64",
    title: "Microsoft Visual C++ 2015-2022 Redistributable (x64)",
    url: "https://aka.ms/vs/17/release/vc_redist.x64.exe",
    publisher: "Microsoft Corporation",
    // NOTE FOR RELEASE: replace with the SHA-256 of the exact build being shipped. The all-zeros value below
    // deliberately fails verification, so an unpinned build cannot be installed by accident.
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    sizeBytes: 25e6,
    silentArguments: ["/install", "/quiet", "/norestart"]
  }
];

// installer/src/build-profile.ts
var BUILD_PROFILE_FORMAT = "infoflex-build-profile";
var BUILD_PROFILE_VERSION = 1;
var ONSITE_PERIOD_CHOICES = [null, 1, 2, 3, 5, 10];
function defaultBuildProfile() {
  return {
    format: BUILD_PROFILE_FORMAT,
    version: BUILD_PROFILE_VERSION,
    appVersion: "0.1.0",
    defaultCurrencyCode: "NGN",
    lockCurrency: false,
    maximumOnsitePeriodYears: null,
    licenseServerUrl: null
  };
}
function buildProfileProblems(profile) {
  const problems = [];
  if (profile.format !== BUILD_PROFILE_FORMAT) {
    problems.push({ field: "format", message: `Unknown profile format "${String(profile.format)}".` });
  }
  if (profile.version !== BUILD_PROFILE_VERSION) {
    problems.push({ field: "version", message: `This build profile is version ${String(profile.version)}; this version of the tools reads version ${BUILD_PROFILE_VERSION}.` });
  }
  if (typeof profile.appVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(profile.appVersion)) {
    problems.push({ field: "appVersion", message: "The version must look like 1.4.2 (numbers separated by dots)." });
  }
  if (profile.prerequisites !== void 0) {
    if (!Array.isArray(profile.prerequisites)) {
      problems.push({ field: "prerequisite", message: "The release prerequisite record must be a list." });
    } else {
      const seen = /* @__PURE__ */ new Set();
      for (const pin of profile.prerequisites) {
        if (pin === null || typeof pin !== "object") {
          problems.push({ field: "prerequisite", message: "The release prerequisite record is not an object." });
        } else if (typeof pin.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pin.sha256)) {
          problems.push({
            field: "prerequisite",
            message: "The release prerequisite checksum must be 64 lowercase hexadecimal characters."
          });
        } else if (!ALLOWLISTED_COMPONENTS.some((component) => component.id === pin.id)) {
          problems.push({ field: "prerequisite", message: `Unknown prerequisite "${String(pin.id)}".` });
        } else if (seen.has(pin.id)) {
          problems.push({ field: "prerequisite", message: `"${pin.id}" is pinned twice.` });
        }
        seen.add(String(pin.id));
      }
    }
  }
  const currency = getCurrency(profile.defaultCurrencyCode);
  if (!currency) {
    problems.push({
      field: "defaultCurrencyCode",
      message: `"${profile.defaultCurrencyCode}" is not a currency in the built-in list. Choose one from the list.`
    });
  }
  if (profile.maximumOnsitePeriodYears !== null) {
    if (!ONSITE_PERIOD_CHOICES.includes(profile.maximumOnsitePeriodYears)) {
      problems.push({
        field: "maximumOnsitePeriodYears",
        message: "The maximum on-site licence period must be No limit, 1, 2, 3, 5 or 10 years."
      });
    }
  }
  if (profile.licenseServerUrl !== null) {
    const problem = serverUrlProblem(profile.licenseServerUrl);
    if (problem) problems.push({ field: "licenseServerUrl", message: problem });
  }
  return problems;
}
function serverUrlProblem(value) {
  if (typeof value !== "string" || !value.trim()) return "Enter the Vendor Cloud address, or leave it blank for no cloud.";
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "That does not look like an address. It should start with https://";
  }
  if (parsed.username || parsed.password) return "Do not put a username or password in the address.";
  if (parsed.search || parsed.hash) return "Do not include a query string or # in the address.";
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.replace(/^\[|\]$/gu, "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return null;
    return "Use https:// for a real address. Plain http:// is only allowed for a test server on this computer.";
  }
  return "The address must start with https://";
}
function serializeBuildProfile(profile) {
  const ordered = {
    format: BUILD_PROFILE_FORMAT,
    version: BUILD_PROFILE_VERSION,
    appVersion: profile.appVersion,
    defaultCurrencyCode: profile.defaultCurrencyCode.toUpperCase(),
    lockCurrency: profile.lockCurrency,
    maximumOnsitePeriodYears: profile.maximumOnsitePeriodYears,
    licenseServerUrl: profile.licenseServerUrl
  };
  if (profile.prerequisites && profile.prerequisites.length > 0) ordered.prerequisites = profile.prerequisites;
  return `${JSON.stringify(ordered, null, 2)}
`;
}

// buildstudio/src/settings-store.ts
var BUILD_STUDIO_SETTINGS_FILENAME = "build-studio-settings.json";
function defaultSettings() {
  return {
    format: "infoflex-build-studio-settings",
    version: 1,
    projectPath: null,
    outputPath: "dist",
    certificatePath: null,
    buildProfile: defaultBuildProfile(),
    autoIncrementVersion: false,
    releaseNotes: "",
    masterPasswordHash: null
  };
}
function settingsPath(directory) {
  return (0, import_node_path.join)(directory, BUILD_STUDIO_SETTINGS_FILENAME);
}
function readSettings(directory) {
  const path = settingsPath(directory);
  if (!(0, import_node_fs.existsSync)(path)) return defaultSettings();
  let parsed;
  try {
    parsed = JSON.parse((0, import_node_fs.readFileSync)(path, "utf8"));
  } catch {
    return defaultSettings();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultSettings();
  const record = parsed;
  const defaults = defaultSettings();
  if (record.format !== defaults.format || record.version !== defaults.version) return defaults;
  return {
    format: defaults.format,
    version: defaults.version,
    projectPath: typeof record.projectPath === "string" ? record.projectPath : null,
    outputPath: typeof record.outputPath === "string" ? record.outputPath : defaults.outputPath,
    certificatePath: typeof record.certificatePath === "string" ? record.certificatePath : null,
    buildProfile: isProfile(record.buildProfile) ? record.buildProfile : defaults.buildProfile,
    autoIncrementVersion: record.autoIncrementVersion === true,
    releaseNotes: typeof record.releaseNotes === "string" ? record.releaseNotes : defaults.releaseNotes,
    masterPasswordHash: isPasswordHash(record.masterPasswordHash) ? record.masterPasswordHash : null
  };
}
function writeSettings(directory, settings2) {
  const text = JSON.stringify(settings2, null, 2);
  if (/PRIVATE KEY/u.test(text)) {
    throw new Error("Build Studio will not write a private key to its settings file.");
  }
  (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(settingsPath(directory)), { recursive: true });
  (0, import_node_fs.writeFileSync)(settingsPath(directory), `${text}
`, "utf8");
}
function isProfile(value) {
  if (!value || typeof value !== "object") return false;
  const record = value;
  return record.format === "infoflex-build-profile" && record.version === 1;
}
function isPasswordHash(value) {
  if (!value || typeof value !== "object") return false;
  const record = value;
  return record.algorithm === "PBKDF2-SHA256" && typeof record.iterations === "number" && typeof record.salt === "string" && typeof record.hash === "string";
}
function incrementVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/u.exec(version);
  if (!match) throw new Error(`"${version}" is not a version number, so it cannot be incremented.`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ?? ""}`;
}

// buildstudio/src/artefacts.ts
var import_node_crypto = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
function declaredArtefacts(version) {
  return BUILD_STEPS.flatMap((step) => step.produces).map((artefact) => ({ ...artefact, path: artefact.path.replace(/\{version\}/gu, version) }));
}
async function sha256File(path) {
  if (!(0, import_node_fs2.existsSync)(path)) return null;
  return new Promise((resolve) => {
    const hash = (0, import_node_crypto.createHash)("sha256");
    const stream = (0, import_node_fs2.createReadStream)(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () => resolve(null));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
async function inspectArtefact(projectRoot, spec, version) {
  const relativePath = spec.path.replace(/\{version\}/gu, version);
  const path = (0, import_node_path2.join)(projectRoot, relativePath);
  const exists = (0, import_node_fs2.existsSync)(path);
  const sizeBytes = exists ? (0, import_node_fs2.statSync)(path).size : 0;
  return {
    title: spec.title,
    path,
    relativePath,
    exists,
    sizeBytes,
    sha256: exists ? await sha256File(path) : null
  };
}
async function inspectAllArtefacts(projectRoot, version) {
  const artefacts = [];
  const missing = [];
  for (const spec of declaredArtefacts(version)) {
    const artefact = await inspectArtefact(projectRoot, spec, version);
    artefacts.push(artefact);
    if (!artefact.exists) missing.push(`${artefact.title} was not produced.`);
  }
  return { artefacts, missing };
}
function windowsDriveRoots(platform, look) {
  if (platform !== "win32") return [];
  const roots = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      const info = look(root);
      if (info.exists && info.isDirectory) roots.push(root);
    } catch {
    }
  }
  return roots;
}
function removableDriveChoices(roots, platform = process.platform) {
  if (platform !== "win32") return roots.map((root) => ({ path: root, label: root }));
  return roots.filter((root) => /^[A-Za-z]:[\\/]?$/u.test(root)).filter((root) => !/^[ABab]:/u.test(root)).filter((root) => !/^[Cc]:/u.test(root)).map((root) => ({ path: root.endsWith("\\") ? root : `${root}\\`, label: `${root.replace(/[\\/:]/gu, "").toUpperCase()} drive` }));
}

// buildstudio/src/authenticode.ts
function authenticodeScript(path) {
  return `(Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/gu, "''")}').SignerCertificate.Subject`;
}
function interpretAuthenticode(input) {
  if (input.exitCode !== 0) return null;
  const subject = input.stdout.trim();
  if (!subject) return null;
  if (subject.includes("\n")) return null;
  return subject;
}
function canCheckAuthenticode(platform) {
  return platform === "win32";
}

// buildstudio/src/licence-keys.ts
var import_node_crypto2 = require("node:crypto");
var KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,40}$/u;
function generateLicenceKeyPair(keyId) {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("The key name must be 3-41 characters: lowercase letters, numbers and dashes, starting with a letter or number.");
  }
  const { privateKey, publicKey } = (0, import_node_crypto2.generateKeyPairSync)("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    keyId,
    privateKeyPem,
    publicKeyPem,
    publicKeyFingerprint: publicKeyFingerprint(publicKeyPem)
  };
}
function publicKeyFingerprint(publicKeyPem) {
  const key = (0, import_node_crypto2.createPublicKey)(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return (0, import_node_crypto2.createHash)("sha256").update(der).digest("base64url");
}

// src/license/vendor-policy.ts
var import_node_crypto3 = require("node:crypto");
var MAX_MASTER_PASSWORD_BYTES = 1024;
var MAX_HASH_ITERATIONS = 2e6;
function verifyMasterPassword(password, value) {
  if (typeof password !== "string" || Buffer.byteLength(password, "utf8") > MAX_MASTER_PASSWORD_BYTES) return false;
  const parsed = validatePasswordHash(value);
  const salt = Buffer.from(parsed.salt, "base64url");
  const expected = Buffer.from(parsed.hash, "base64url");
  const actual = (0, import_node_crypto3.pbkdf2Sync)(password, salt, parsed.iterations, expected.length, "sha256");
  return actual.length === expected.length && actual.reduce((difference, byte, index) => difference | byte ^ expected[index], 0) === 0;
}
function validatePasswordHash(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The vendor policy has no salted master-password hash.");
  const record = value;
  if (record.algorithm !== "PBKDF2-SHA256" || !Number.isInteger(record.iterations) || record.iterations < 1e5 || record.iterations > MAX_HASH_ITERATIONS || typeof record.salt !== "string" || typeof record.hash !== "string") {
    throw new Error("The vendor master-password hash is invalid.");
  }
  const salt = decodeBase64Url(record.salt, "salt");
  const hash = decodeBase64Url(record.hash, "hash");
  if (salt.length < 16 || salt.length > 64 || hash.length < 32 || hash.length > 64) {
    throw new Error("The vendor master-password hash has invalid dimensions.");
  }
  return {
    algorithm: "PBKDF2-SHA256",
    iterations: record.iterations,
    salt: record.salt,
    hash: record.hash
  };
}
function decodeBase64Url(value, field) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`The master-password ${field} encoding is invalid.`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error(`The master-password ${field} encoding is invalid.`);
  return decoded;
}

// buildstudio/main.ts
var window = null;
var settings = defaultSettings();
var settingsDirectory = "";
var running = null;
var logPath = "";
var runSecrets = [];
function settingsDir() {
  return (0, import_node_path3.join)(import_electron.app.getPath("userData"));
}
function createWindow() {
  window = new import_electron.BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: "Infoflex Build Studio",
    backgroundColor: "#f7f4ee",
    icon: (0, import_node_path3.join)(__dirname, "../build/icon.ico"),
    // No menu bar: the brief asks for buttons, and a stray View/Reload menu is a way to get into a state a
    // non-programmer cannot get out of.
    autoHideMenuBar: true,
    webPreferences: {
      // The window shows local HTML and talks through this one preload bridge; nothing remote is loaded.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: (0, import_node_path3.join)(__dirname, "preload.js")
    }
  });
  void window.loadFile((0, import_node_path3.join)(__dirname, "index.html"));
  window.on("closed", () => {
    window = null;
  });
}
import_electron.app.whenReady().then(() => {
  settingsDirectory = settingsDir();
  settings = readSettings(settingsDirectory);
  logPath = (0, import_node_path3.join)(settingsDirectory, "build-studio.log");
  createWindow();
  import_electron.app.on("activate", () => {
    if (import_electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  import_electron.dialog.showErrorBox("Infoflex Build Studio could not start", error instanceof Error ? error.message : String(error));
});
import_electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") import_electron.app.quit();
});
function log(line) {
  const text = redactSecrets(line, runSecrets);
  try {
    (0, import_node_fs3.appendFileSync)(logPath, `${(/* @__PURE__ */ new Date()).toISOString()} ${text}
`, "utf8");
  } catch {
  }
  window?.webContents.send("log:line", text);
}
function probeVersion(command, args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = (0, import_node_child_process2.spawn)(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      done(null);
      return;
    }
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? output.split(/\r?\n/u).find((line) => line.trim()) ?? null : null));
    setTimeout(() => {
      done(null);
      try {
        child.kill();
      } catch {
      }
    }, 15e3).unref();
  });
}
function probeCppTools() {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = (0, import_node_child_process2.spawn)("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\Installer", "/s", "/f", "VC,Tools"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      done(null);
      return;
    }
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 && output.length > 0));
    setTimeout(() => {
      done(null);
      try {
        child.kill();
      } catch {
      }
    }, 2e4).unref();
  });
}
function freeDiskBytes(path) {
  return new Promise((resolve) => {
    import("node:fs").then(({ statfs }) => {
      statfs(path, (error, stats) => {
        if (error) resolve(1n << 40n);
        else resolve(BigInt(stats.bavail) * BigInt(stats.bsize));
      });
    }).catch(() => resolve(1n << 40n));
  });
}
import_electron.ipcMain.handle("settings:read", () => settings);
import_electron.ipcMain.handle("settings:write", (_event, next) => {
  settings = { ...next, masterPasswordHash: next.masterPasswordHash ?? settings.masterPasswordHash };
  writeSettings(settingsDirectory, settings);
  log("Settings saved.");
  return settings;
});
import_electron.ipcMain.handle("dialog:pick-folder", async (_event, current) => {
  if (!window) return null;
  const result = await import_electron.dialog.showOpenDialog(window, {
    title: "Choose the Infoflex project folder",
    defaultPath: current ?? (0, import_node_os.homedir)(),
    properties: ["openDirectory"]
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
import_electron.ipcMain.handle("dialog:pick-file", async (_event, title) => {
  if (!window) return null;
  const result = await import_electron.dialog.showOpenDialog(window, { title, properties: ["openFile"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
import_electron.ipcMain.handle("dialog:save-private-key", async (_event, pem, keyId) => {
  if (!window) return null;
  const result = await import_electron.dialog.showSaveDialog(window, {
    title: "Save the private signing key (keep this file safe)",
    defaultPath: (0, import_node_path3.join)((0, import_node_os.homedir)(), `${keyId}-PRIVATE-KEY.pem`),
    filters: [{ name: "Key file", extensions: ["pem"] }]
  });
  if (result.canceled || !result.filePath) return null;
  (0, import_node_fs3.writeFileSync)(result.filePath, pem, { encoding: "utf8", mode: 384 });
  log(`Private signing key for "${keyId}" saved. Its contents are deliberately not logged.`);
  return result.filePath;
});
import_electron.ipcMain.handle("project:detect", (_event, folder) => {
  try {
    const manifest = JSON.parse((0, import_node_fs3.readFileSync)((0, import_node_path3.join)(folder, "package.json"), "utf8"));
    return { ok: true, name: manifest.name ?? "Infoflex", version: manifest.version ?? "0.0.0" };
  } catch {
    return { ok: false, message: "That folder does not look like the Infoflex project: there is no readable package.json in it." };
  }
});
import_electron.ipcMain.handle("check:run", async () => {
  log("Checking this computer.");
  const result = await runSystemCheck({
    probe: async (tool) => tool.probe ? probeVersion(tool.probe.command, tool.probe.args) : null,
    probePartialInstall: probeCppTools,
    freeDiskBytes: () => freeDiskBytes(settings.projectPath ?? process.cwd()),
    canInstall: (tool) => planDownload(tool.id).ok
  });
  log(result.headline);
  return result;
});
import_electron.ipcMain.handle("tools:install", async (_event, ids) => {
  if (!window) return { ok: false, message: "The window is closed." };
  const results = [];
  for (const id of ids) {
    const tool = findTool(id);
    if (!tool) continue;
    const planned = planDownload(id);
    if (!planned.ok) {
      results.push({ id, ok: false, message: planned.reason });
      log(`${tool.title}: ${planned.reason}`);
      continue;
    }
    log(`Downloading ${tool.title} from ${new URL(planned.plan.url).hostname}.`);
    const target = (0, import_node_path3.join)((0, import_node_os.tmpdir)(), `infoflex-${id}${planned.plan.url.endsWith(".msi") ? ".msi" : ".exe"}`);
    const download = await downloadToFile(planned.plan.url, target, tool.title);
    if (!download.ok) {
      results.push({ id, ok: false, message: download.message });
      continue;
    }
    log(`Running the ${tool.title} installer without opening a window.`);
    const exitCode = await runInstaller(target, planned.plan.silentArguments);
    results.push({
      id,
      ok: exitCode === 0 || exitCode === 3010,
      message: exitCode === 3010 ? `${tool.title} installed; Windows wants a restart to finish.` : exitCode === 0 ? `${tool.title} installed.` : `${tool.title} installer finished with code ${exitCode}.`
    });
  }
  return { ok: results.every((result) => result.ok), results };
});
async function downloadToFile(url, target, title) {
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) return { ok: false, message: `${title} could not be downloaded (the server said ${response.status}).` };
    const buffer = Buffer.from(await response.arrayBuffer());
    (0, import_node_fs3.mkdirSync)((0, import_node_path3.join)(target, ".."), { recursive: true });
    (0, import_node_fs3.writeFileSync)(target, buffer);
    log(`Downloaded ${buffer.length} bytes.`);
    const publisher = await authenticodePublisher(target);
    if (publisher === null) {
      return { ok: false, message: `${title} was downloaded but its publisher could not be verified, so it will not be run. You can install it yourself from the official website.` };
    }
    log(`Publisher verified: ${publisher}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `${title} could not be downloaded: ${error instanceof Error ? error.message : String(error)}. You can install it yourself from the official website.` };
  }
}
function authenticodePublisher(path) {
  if (!canCheckAuthenticode(process.platform)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const script = authenticodeScript(path);
    let child;
    try {
      child = (0, import_node_child_process2.spawn)("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      resolve(null);
      return;
    }
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(interpretAuthenticode({ exitCode: code, stdout: output })));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      resolve(null);
    }, 3e4).unref();
  });
}
function runInstaller(path, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = (0, import_node_child_process2.spawn)(path, args, { windowsHide: true, stdio: "ignore" });
    } catch {
      resolve(null);
      return;
    }
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}
import_electron.ipcMain.handle("build:run", async (_event, group) => {
  if (running) return { ok: false, message: "A build is already running." };
  const steps = stepsForGroup(group);
  const projectPath = settings.projectPath;
  if (!projectPath) return { ok: false, message: "Choose the project folder first." };
  const total = totalWeight(steps);
  let doneWeight = 0;
  const problems = buildProfileProblems(settings.buildProfile);
  if (problems.length > 0) {
    return { ok: false, message: problems.map((problem) => problem.message).join(" ") };
  }
  const profileVersion = settings.autoIncrementVersion ? incrementVersion(settings.buildProfile.appVersion) : settings.buildProfile.appVersion;
  const profile = { ...settings.buildProfile, appVersion: profileVersion };
  (0, import_node_fs3.writeFileSync)((0, import_node_path3.join)(projectPath, "build-profile.json"), serializeBuildProfile(profile), "utf8");
  (0, import_node_fs3.writeFileSync)((0, import_node_path3.join)(projectPath, "buildprofile.generated.json"), serializeBuildProfile(profile), "utf8");
  log(`Build profile written: currency ${profile.defaultCurrencyCode}${profile.lockCurrency ? " (locked)" : ""}, version ${profileVersion}.`);
  for (const step of steps) {
    window?.webContents.send("build:step", { id: step.id, title: step.title, detail: step.detail });
    log(`--- ${step.title}`);
    const command = runCommand({
      cwd: projectPath,
      command: step.command,
      args: step.args,
      secrets: runSecrets,
      env: { INFOFLEX_BUILD_PROFILE: profile.defaultCurrencyCode, INFOFLEX_BUILD_VERSION: profileVersion },
      onLine: (line) => log(line),
      onDone: () => {
      },
      idleNoticeMs: 2e4,
      idleNotice: (elapsed) => log(`Still working\u2026 (${Math.round(elapsed / 1e3)}s with no output, which is normal for this step).`)
    });
    running = command;
    const result = await command.done;
    running = null;
    if (result.cancelled) {
      log("Build cancelled.");
      return { ok: false, cancelled: true, message: "The build was cancelled. Nothing was copied anywhere." };
    }
    if (result.exitCode !== 0) {
      const explanation = explainFailure({ step, output: "", exitCode: result.exitCode });
      log(`${explanation.cause} ${explanation.fixes.join(" ")}`);
      return { ok: false, message: explanation.cause, detail: explanation.fixes };
    }
    doneWeight += step.weight;
    window?.webContents.send("build:progress", { percent: Math.floor(doneWeight / total * 100) });
  }
  const report = await inspectAllArtefacts(projectPath, profileVersion);
  log(report.missing.length === 0 ? "Every promised file was produced." : report.missing.join(" "));
  return { ok: report.missing.length === 0, artefacts: report.artefacts, missing: report.missing };
});
import_electron.ipcMain.handle("build:cancel", () => {
  running?.cancel();
});
import_electron.ipcMain.handle("artefacts:verify", async () => {
  if (!settings.projectPath) return { ok: false, message: "Choose the project folder first." };
  return inspectAllArtefacts(settings.projectPath, settings.buildProfile.appVersion);
});
import_electron.ipcMain.handle("artefacts:open-folder", async () => {
  if (!settings.projectPath) return false;
  await import_electron.shell.openPath((0, import_node_path3.join)(settings.projectPath, settings.outputPath ?? "dist"));
  return true;
});
import_electron.ipcMain.handle("artefacts:copy-to-drive", async (_event, drivePath) => {
  if (!settings.projectPath) return { ok: false, message: "Choose the project folder first." };
  const report = await inspectAllArtefacts(settings.projectPath, settings.buildProfile.appVersion);
  const built = report.artefacts.filter((artefact) => artefact.exists);
  if (built.length === 0) return { ok: false, message: "There is nothing built yet to copy." };
  const folder = (0, import_node_path3.join)(drivePath, "Infoflex Installers");
  (0, import_node_fs3.mkdirSync)(folder, { recursive: true });
  for (const artefact of built) {
    (0, import_node_fs3.cpSync)(artefact.path, (0, import_node_path3.join)(folder, `${artefact.title}`));
  }
  log(`Copied ${built.length} files to ${folder}.`);
  return { ok: true, message: `Copied ${built.length} files to ${folder}.`, folder };
});
import_electron.ipcMain.handle("drives:list", () => (
  // Electron has no cross-platform drive enumeration; on Windows the letters that exist are the useful answer.
  removableDriveChoices(windowsDriveRoots(process.platform, (path) => {
    const exists = (0, import_node_fs3.existsSync)(path);
    return { exists, isDirectory: exists && (0, import_node_fs3.statSync)(path).isDirectory() };
  }))
));
import_electron.ipcMain.handle("vendor:unlock", (_event, password) => {
  if (!settings.masterPasswordHash) {
    return { ok: false, message: "Set the vendor master password in the app's vendor policy first, then import that policy here." };
  }
  const ok = verifyMasterPassword(password, settings.masterPasswordHash);
  log(ok ? "Vendor tools unlocked." : "Vendor tools: wrong password.");
  return ok ? { ok: true } : { ok: false, message: "That password is not correct." };
});
import_electron.ipcMain.handle("vendor:generate-keys", (_event, keyId) => {
  try {
    const pair = generateLicenceKeyPair(keyId);
    return { ok: true, publicKeyPem: pair.publicKeyPem, fingerprint: pair.publicKeyFingerprint, privateKeyPem: pair.privateKeyPem };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});
import_electron.ipcMain.handle("app:open-policy-page", async () => {
  await import_electron.shell.openPath((0, import_node_path3.join)(__dirname, "policy.html"));
  return true;
});
import_electron.ipcMain.handle("log:path", () => logPath);
import_electron.ipcMain.handle("log:open", async () => {
  await import_electron.shell.openPath(logPath);
  return true;
});
import_electron.ipcMain.handle("log:copy", () => {
  try {
    return (0, import_node_fs3.readFileSync)(logPath, "utf8");
  } catch {
    return "";
  }
});
import_electron.ipcMain.handle("app:currencies", () => (
  // The same table the app itself uses, so Build Studio cannot offer a currency the build does not know.
  CURRENCIES.map((currency) => ({ code: currency.code, name: currency.name, symbol: currency.symbol }))
));
import_electron.ipcMain.handle("app:info", () => ({ version: import_electron.app.getVersion(), tools: TOOLS.map((tool) => ({ id: tool.id, title: tool.title, required: tool.required })), steps: BUILD_STEPS.map((step) => ({ id: step.id, title: step.title, detail: step.detail })) }));
