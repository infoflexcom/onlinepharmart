"use strict";

// buildstudio/ui.ts
function isReport(value) {
  return Boolean(value) && Array.isArray(value.artefacts);
}
var $ = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Build Studio is missing part of its window: ${id}`);
  return element;
};
var currencies = [];
var settings;
var lastGroup = "do-everything";
var unbindLog = null;
function showTab(name) {
  for (const button of document.querySelectorAll("#tabs button")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.classList.toggle("hidden", panel.dataset.panel !== name);
  }
}
for (const button of document.querySelectorAll("#tabs button")) {
  button.addEventListener("click", () => showTab(button.dataset.tab ?? "welcome"));
}
function appendLog(line, isError = false) {
  const box = $("build-log");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  const row = document.createElement("div");
  if (isError || /\berror\b|\bfail/iu.test(line)) row.className = "err";
  row.textContent = line;
  box.append(row);
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function renderCurrencySelect() {
  const select = $("default-currency");
  select.innerHTML = "";
  for (const currency of currencies) {
    const option = document.createElement("option");
    option.value = currency.code;
    option.textContent = `${currency.code} - ${currency.name} (${currency.symbol})`;
    select.append(option);
  }
  select.value = settings.buildProfile.defaultCurrencyCode;
}
function renderOnsitePeriods() {
  const select = $("onsite-period");
  select.innerHTML = "";
  const choices = [
    ["", "No limit"],
    ["1", "1 year"],
    ["2", "2 years"],
    ["3", "3 years"],
    ["5", "5 years"],
    ["10", "10 years"]
  ];
  for (const [value, label] of choices) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = settings.buildProfile.maximumOnsitePeriodYears === null ? "" : String(settings.buildProfile.maximumOnsitePeriodYears);
}
function renderSettings() {
  ;
  $("project-path").value = settings.projectPath ?? "";
  $("output-path").value = settings.outputPath ?? "dist";
  $("cert-path").value = settings.certificatePath ?? "";
  $("cloud-url").value = settings.buildProfile.licenseServerUrl ?? "";
  $("app-version-input").value = settings.buildProfile.appVersion;
  $("auto-increment").checked = settings.autoIncrementVersion;
  $("release-notes").value = settings.releaseNotes ?? "";
  $("lock-currency").value = settings.buildProfile.lockCurrency ? "on" : "off";
  renderCurrencySelect();
  renderOnsitePeriods();
}
function collectSettings() {
  const next = {
    ...settings,
    outputPath: $("output-path").value.trim() || "dist",
    autoIncrementVersion: $("auto-increment").checked,
    releaseNotes: $("release-notes").value,
    buildProfile: {
      appVersion: $("app-version-input").value.trim(),
      defaultCurrencyCode: $("default-currency").value,
      lockCurrency: $("lock-currency").value === "on",
      maximumOnsitePeriodYears: $("onsite-period").value === "" ? null : Number($("onsite-period").value),
      licenseServerUrl: $("cloud-url").value.trim() || null
    }
  };
  return next;
}
function glyph(state) {
  return state === "ok" ? "\u2713" : state === "blocked" ? "\u2715" : "\u2193";
}
function renderChecks(result) {
  const list = $("checks");
  list.innerHTML = "";
  for (const check of result.checks) {
    const row = document.createElement("div");
    row.className = `check ${check.state === "ok" ? "ok" : check.state === "blocked" ? "red" : "orange"}`;
    const glyphBox = document.createElement("div");
    glyphBox.className = "glyph";
    glyphBox.textContent = glyph(check.state);
    const body = document.createElement("div");
    body.className = "body";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = check.title;
    if (!check.required) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "optional";
      name.append(tag);
    }
    const message = document.createElement("div");
    message.className = "msg";
    message.textContent = check.message;
    body.append(name, message);
    row.append(glyphBox, body);
    list.append(row);
  }
  const verdict = $("verdict");
  verdict.className = `verdict ${result.ready ? "ready" : "notready"}`;
  verdict.textContent = result.headline;
  verdict.classList.remove("hidden");
  const installable = result.checks.filter((check) => check.state === "missing-installable" && check.required);
  $("install-missing").disabled = installable.length === 0;
  $("install-missing").textContent = installable.length > 0 ? `Install ${installable.length === 1 ? "the missing tool" : `the ${installable.length} missing tools`}` : "Nothing missing to install";
  $("browse-installer").disabled = installable.length === 0;
}
async function runCheck() {
  showTab("check");
  const button = $("run-check");
  button.disabled = true;
  button.textContent = "Checking\u2026";
  $("check-errors").innerHTML = "";
  try {
    renderChecks(await window.studio.check.run());
  } catch (error) {
    showError("check-errors", error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    button.textContent = "Check again";
  }
}
function showError(containerId, message, fixes = []) {
  const container = $(containerId);
  const box = document.createElement("div");
  box.className = "errbox";
  const heading = document.createElement("h4");
  heading.textContent = "That did not work";
  const text = document.createElement("div");
  text.textContent = message;
  box.append(heading, text);
  if (fixes.length > 0) {
    const list = document.createElement("ul");
    for (const fix of fixes) {
      const item = document.createElement("li");
      item.textContent = fix;
      list.append(item);
    }
    box.append(list);
  }
  container.innerHTML = "";
  container.append(box);
}
function setBuilding(active) {
  for (const id of ["do-everything", "install-missing"]) {
    const element = document.getElementById(id);
    if (element) element.disabled = active;
  }
  for (const button of document.querySelectorAll("[data-build]")) button.disabled = active;
  $("cancel-build").disabled = !active;
}
async function runBuild(group) {
  lastGroup = group;
  showTab("build");
  $("build-log").innerHTML = "";
  $("build-errors").innerHTML = "";
  $("retry-build").disabled = true;
  $("build-bar").style.width = "0%";
  $("build-step").textContent = "Starting\u2026";
  setBuilding(true);
  const started = Date.now();
  const timer = window.setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1e3);
    $("build-elapsed").textContent = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }, 1e3);
  const removeStep = window.studio.build.onStep((step) => {
    ;
    $("build-step").textContent = `${step.title} \u2014 ${step.detail}`;
  });
  const removeProgress = window.studio.build.onProgress((value) => {
    ;
    $("build-bar").style.width = `${value.percent}%`;
  });
  try {
    const result = await window.studio.build.run(group);
    if (!result.ok) {
      if (result.cancelled) {
        ;
        $("build-step").textContent = "Cancelled.";
      } else {
        showError("build-errors", result.message ?? "The build stopped.", result.detail ?? []);
        $("retry-build").disabled = false;
      }
    } else {
      ;
      $("build-bar").style.width = "100%";
      $("build-step").textContent = "Finished.";
      await refreshArtefacts();
      showTab("output");
    }
  } catch (error) {
    showError("build-errors", error instanceof Error ? error.message : String(error));
    $("retry-build").disabled = false;
  } finally {
    window.clearInterval(timer);
    setBuilding(false);
    removeStep();
    removeProgress();
  }
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
function renderArtefacts(report) {
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const label of ["File", "Size", "Fingerprint (SHA-256)", "Built"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const artefact of report.artefacts) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = artefact.title;
    const size = document.createElement("td");
    size.textContent = artefact.exists ? formatBytes(artefact.sizeBytes) : "\u2014";
    const hash = document.createElement("td");
    hash.className = "mono";
    hash.textContent = artefact.sha256 ?? "\u2014";
    const state = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `pill ${artefact.exists ? "yes" : "no"}`;
    pill.textContent = artefact.exists ? "yes" : "missing";
    state.append(pill);
    row.append(name, size, hash, state);
    table.append(row);
  }
  const container = $("artefacts");
  container.innerHTML = "";
  container.append(table);
  if (report.missing.length > 0) {
    const note = document.createElement("div");
    note.className = "callout bad";
    note.textContent = report.missing.join(" ");
    container.prepend(note);
  }
}
async function refreshArtefacts() {
  try {
    const report = await window.studio.artefacts.verify();
    if (!isReport(report)) {
      const container = $("artefacts");
      container.textContent = "";
      const note = document.createElement("div");
      note.className = "callout bad";
      note.textContent = report?.message ?? "Choose the project folder first.";
      container.append(note);
      return;
    }
    renderArtefacts(report);
  } catch (error) {
    showError("artefacts", error instanceof Error ? error.message : String(error));
  }
}
async function refreshDrives() {
  const container = $("drives");
  container.innerHTML = "";
  const drives = await window.studio.drives.list();
  if (drives.length === 0) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "No other drive found. Plug in the USB drive and press Refresh.";
    container.append(note);
    return;
  }
  for (const drive of drives) {
    const button = document.createElement("button");
    button.className = "drive";
    button.innerHTML = "";
    const name = document.createElement("b");
    name.textContent = drive.label;
    const path = document.createElement("span");
    path.className = "muted";
    path.textContent = drive.path;
    button.append(name, path);
    button.addEventListener("click", async () => {
      const result = await window.studio.artefacts.copyToDrive(drive.path);
      const box = $("copy-result");
      box.innerHTML = "";
      const note = document.createElement("div");
      note.className = result.ok ? "callout" : "callout bad";
      note.textContent = result.message;
      box.append(note);
    });
    container.append(button);
  }
}
function renderKeys(result) {
  const container = $("key-result");
  container.innerHTML = "";
  const heading = document.createElement("div");
  heading.className = "callout";
  heading.innerHTML = `<strong>Public key</strong> \u2014 this is the half that goes into builds. Its fingerprint is <span class="mono">${result.fingerprint}</span>.`;
  const box = document.createElement("div");
  box.className = "keybox";
  box.textContent = result.publicKeyPem;
  const warning = document.createElement("div");
  warning.className = "callout bad";
  warning.innerHTML = '<strong>The private key has not been saved yet.</strong> Press "Save the private key" and choose a safe place. Upload it to the Vendor Cloud as a secret. Never put it in a build, an email or this folder.';
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = "Save the private key\u2026";
  container.append(heading, box, warning, save);
  const pending = result.privateKeyPem;
  save.addEventListener("click", async () => {
    const keyId = $("key-id").value.trim();
    const path = await window.studio.dialog.savePrivateKey(pending ?? "", keyId);
    if (path) {
      warning.className = "callout";
      warning.innerHTML = `<strong>Saved</strong> to <span class="mono">${path}</span>. Upload it to the Vendor Cloud now and keep a backup somewhere safe.`;
      save.remove();
    }
  });
}
async function start() {
  settings = await window.studio.settings.read();
  renderSettings();
  currencies = await window.studio.app.currencies();
  renderCurrencySelect();
  const info = await window.studio.app.info();
  $("app-version").textContent = `Version ${info.version}`;
  unbindLog = window.studio.log.onLine((line) => appendLog(line));
  void unbindLog;
  if (settings.projectPath) {
    const detected = await window.studio.project.detect(settings.projectPath);
    $("project-info").textContent = detected.ok ? `${detected.name} ${detected.version} \u2014 this looks right.` : detected.message ?? "That folder does not look right.";
  }
  showTab("welcome");
}
$("start-check").addEventListener("click", () => {
  void runCheck();
});
$("run-check").addEventListener("click", () => {
  void runCheck();
});
$("install-missing").addEventListener("click", async () => {
  const checks = await window.studio.check.run();
  const missing = checks.checks.filter((check) => check.state === "missing-installable" && check.required).map((check) => check.id);
  $("install-missing").disabled = true;
  $("install-missing").textContent = "Installing\u2026";
  try {
    const result = await window.studio.tools.install(missing);
    if (!result.ok) {
      showError("check-errors", "Some tools could not be installed automatically.", result.results.filter((r) => !r.ok).map((r) => r.message));
    }
  } finally {
    await runCheck();
  }
});
$("browse-installer").addEventListener("click", async () => {
  const path = await window.studio.dialog.pickFile("Choose the installer you downloaded");
  const box = $("check-errors");
  if (path) box.innerHTML = `<div class="callout">Chosen: <span class="mono">${path}</span>. Run it, then press "Check again".</div>`;
});
$("pick-project").addEventListener("click", async () => {
  const folder = await window.studio.dialog.pickFolder(settings.projectPath);
  if (!folder) return;
  const detected = await window.studio.project.detect(folder);
  if (!detected.ok) {
    showError("project-error", detected.message ?? "That folder does not look like the Infoflex project.");
    return;
  }
  settings = await window.studio.settings.write({ ...settings, projectPath: folder });
  $("project-path").value = folder;
  $("project-info").textContent = `${detected.name} ${detected.version} \u2014 this looks right.`;
  $("project-error").innerHTML = "";
});
$("do-everything").addEventListener("click", () => {
  if (!settings.projectPath) {
    showTab("project");
    showError("project-error", "Choose the project folder first.");
    return;
  }
  void runBuild("do-everything");
});
for (const button of document.querySelectorAll("[data-build]")) {
  button.addEventListener("click", () => {
    if (!settings.projectPath) {
      showTab("project");
      showError("project-error", "Choose the project folder first.");
      return;
    }
    void runBuild(button.dataset.build ?? "do-everything");
  });
}
$("cancel-build").addEventListener("click", () => {
  void window.studio.build.cancel();
});
$("retry-build").addEventListener("click", () => {
  void runBuild(lastGroup);
});
$("open-log").addEventListener("click", () => {
  void window.studio.log.open();
});
$("copy-errors").addEventListener("click", async () => {
  const text = await window.studio.log.copy();
  await navigator.clipboard.writeText(text);
  $("copy-errors").textContent = "Copied";
  window.setTimeout(() => {
    ;
    $("copy-errors").textContent = "Copy error details";
  }, 2e3);
});
$("refresh-output").addEventListener("click", () => {
  void refreshArtefacts();
});
$("open-folder").addEventListener("click", () => {
  void window.studio.artefacts.openFolder();
});
$("refresh-drives").addEventListener("click", () => {
  void refreshDrives();
});
$("unlock-vendor").addEventListener("click", async () => {
  const password = $("vendor-password").value;
  if (!password) return;
  const result = await window.studio.vendor.unlock(password);
  $("vendor-password").value = "";
  if (result.ok) {
    $("vendor-locked").classList.add("hidden");
    $("vendor-unlocked").classList.remove("hidden");
    $("unlock-error").innerHTML = "";
  } else {
    showError("unlock-error", result.message ?? "That password is not correct.");
  }
});
$("open-policy-page").addEventListener("click", () => {
  void window.studio.app.openPolicyPage();
});
$("generate-keys").addEventListener("click", async () => {
  const keyId = $("key-id").value.trim();
  const result = await window.studio.vendor.generateKeys(keyId);
  if (!result.ok || !result.publicKeyPem || !result.fingerprint) {
    showError("key-result", result.message ?? "The key could not be generated.");
    return;
  }
  renderKeys({ publicKeyPem: result.publicKeyPem, fingerprint: result.fingerprint, privateKeyPem: result.privateKeyPem });
});
$("save-notes").addEventListener("click", async () => {
  settings = await window.studio.settings.write(collectSettings());
  $("notes-result").textContent = "Saved.";
});
$("pick-output").addEventListener("click", async () => {
  const folder = await window.studio.dialog.pickFolder(settings.projectPath);
  if (!folder) return;
  $("output-path").value = folder;
});
$("pick-cert").addEventListener("click", async () => {
  const path = await window.studio.dialog.pickFile("Choose the code-signing certificate");
  if (path) $("cert-path").value = path;
});
$("save-settings").addEventListener("click", async () => {
  const next = collectSettings();
  const problems = [];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(next.buildProfile.appVersion)) problems.push("The version must look like 1.4.2.");
  if (next.buildProfile.licenseServerUrl) {
    try {
      const url = new URL(next.buildProfile.licenseServerUrl);
      const local = ["localhost", "127.0.0.1"].includes(url.hostname);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) problems.push("The Vendor Cloud address must start with https://");
    } catch {
      problems.push("The Vendor Cloud address does not look like an address.");
    }
  }
  if (problems.length > 0) {
    showError("settings-problems", "These settings need fixing.", problems);
    return;
  }
  $("settings-problems").innerHTML = "";
  settings = await window.studio.settings.write(next);
  const saved = $("settings-saved");
  saved.textContent = "Saved.";
  window.setTimeout(() => {
    saved.textContent = "";
  }, 2500);
});
void start();
