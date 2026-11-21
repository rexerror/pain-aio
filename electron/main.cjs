"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  globalShortcut,
  safeStorage,
  clipboard,
  nativeImage
} = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

// 1. Load local Ed25519 keypair & recaptcha assets
const APP_ROOT = path.resolve(__dirname, "..");
const KEYPAIR_PATH = path.join(__dirname, "local-ed25519-keypair.json");
const RECAPTCHA_ASSETS_PATH = path.join(__dirname, "recaptcha-assets.json");
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));

const keypair = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
const recaptchaAssets = JSON.parse(fs.readFileSync(RECAPTCHA_ASSETS_PATH, "utf8"));

// Configure dedicated user data directory for the clone
const USER_DATA_DIR = process.env.PHOMA_TEST_USER_DATA_DIR || path.join(APP_ROOT, ".pain-aio-data");
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
app.setPath("userData", USER_DATA_DIR);
app.setName("PAIN-AiO");
if (process.platform === "win32") {
  app.setAppUserModelId("com.pain.aio");
}

// 2. Deterministic Device Identity & Lease Signer
const INSTALLATION_FILE = path.join(USER_DATA_DIR, "installation.json");
function getOrCreateInstallationId() {
  try {
    if (fs.existsSync(INSTALLATION_FILE)) {
      const data = JSON.parse(fs.readFileSync(INSTALLATION_FILE, "utf8"));
      if (data && typeof data.installationId === "string" && data.installationId.trim()) {
        return data.installationId.trim();
      }
    }
  } catch {}
  const id = crypto.randomUUID();
  try {
    fs.writeFileSync(INSTALLATION_FILE, JSON.stringify({ installationId: id, createdAt: new Date().toISOString() }, null, 2));
  } catch {}
  return id;
}

function getMachineId() {
  try {
    const nm = require("node-machine-id");
    return nm.machineIdSync(true);
  } catch {
    return crypto.createHash("sha256").update(os.hostname() + os.platform() + os.arch()).digest("hex");
  }
}

const INSTALLATION_ID = getOrCreateInstallationId();
const MACHINE_ID = getMachineId();
const LEGACY_OFFLINE_TOKEN = "phoma-local-pro-unlimited-access-token";

function getDeviceInfo() {
  let curVer = PKG_JSON.version || "1.7.4";
  try {
    const latestPkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));
    if (latestPkg.version) curVer = latestPkg.version;
  } catch {}
  return {
    installationId: INSTALLATION_ID,
    machineId: MACHINE_ID,
    deviceName: os.hostname() || "PAIN-AiO-PC",
    os: process.platform,
    osVersion: os.release(),
    arch: process.arch,
    appVersion: curVer,
    hardwareIdentity: {
      status: "available",
      smbios_uuid: INSTALLATION_ID,
      manufacturer: "PAIN-AiO",
      serialNumber: MACHINE_ID.slice(0, 16)
    }
  };
}

// 3. Remote Cloud License & 1-Device HWID Lock Server (Cloudflare Worker)
const licenseServerOrigin = "https://pain-aio-auth.nd-thngg.workers.dev";

// 4. Secret Codec for GPT & Voice credentials
function createSecretCodec() {
  const key = crypto.createHash("sha256").update(`phoma-local-secret:${MACHINE_ID}`).digest();
  return {
    encrypt(plaintext) {
      try {
        if (safeStorage && safeStorage.isEncryptionAvailable()) {
          return "safe:" + safeStorage.encryptString(String(plaintext)).toString("base64");
        }
      } catch {}
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return "aes:" + Buffer.concat([iv, tag, enc]).toString("base64");
    },
    decrypt(ciphertext) {
      const str = String(ciphertext);
      if (str.startsWith("safe:")) {
        return safeStorage.decryptString(Buffer.from(str.slice(5), "base64"));
      }
      if (str.startsWith("aes:")) {
        const raw = Buffer.from(str.slice(4), "base64");
        const iv = raw.subarray(0, 12);
        const tag = raw.subarray(12, 28);
        const enc = raw.subarray(28);
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
      }
      return Buffer.from(str, "base64").toString("utf8");
    }
  };
}

// 5. VieNeu Runtime Host (wraps unpacked voice-vieneu/vieneu-worker.exe)
function createVoiceRuntimeHost() {
  const unpackedVieneuDir = path.join(APP_ROOT, "voice-vieneu");

  let activeChild = null;

  return {
    async isAvailable(device = "cpu") {
      if (device === "cpu") {
        return fs.existsSync(path.join(unpackedVieneuDir, "vieneu-worker.exe"));
      }
      return false;
    },
    async cudaRuntimeAssets() {
      return [];
    },
    async infer(params) {
      const exePath = path.join(unpackedVieneuDir, "vieneu-worker.exe");
      if (!fs.existsSync(exePath)) {
        throw new Error("Không tìm thấy vieneu-worker.exe.");
      }

      const items = params.items || [{ text: params.text, outputFile: params.outputFile }];
      const requestPayload = {
        command: "SYNTHESIZE",
        modelDirectory: params.modelDirectory,
        voice: params.voice,
        referenceAudio: params.referenceAudio,
        denoiseReference: params.denoiseReference,
        temperature: params.temperature,
        maxChars: params.maxChars,
        batchSize: params.batchSize,
        items
      };

      return new Promise((resolve, reject) => {
        const child = spawn(exePath, [], {
          cwd: unpackedVieneuDir,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
            HF_HUB_DISABLE_TELEMETRY: "1"
          }
        });
        activeChild = child;

        let stdoutStr = "";
        let stderrStr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d) => { stdoutStr += d; });
        child.stderr.on("data", (d) => { stderrStr += d; });

        const onAbort = () => {
          try { child.kill("SIGKILL"); } catch {}
          reject(new Error("VieNeu inference cancelled."));
        };
        if (params.signal) {
          params.signal.addEventListener("abort", onAbort, { once: true });
        }

        child.on("error", (err) => {
          if (params.signal) params.signal.removeEventListener("abort", onAbort);
          activeChild = null;
          reject(err);
        });

        child.on("close", (code) => {
          if (params.signal) params.signal.removeEventListener("abort", onAbort);
          activeChild = null;
          if (code !== 0) {
            reject(new Error(stderrStr.trim() || `VieNeu worker exited (${code})`));
            return;
          }
          resolve();
        });

        child.stdin.write(JSON.stringify(requestPayload) + "\n");
        child.stdin.end();
      });
    },
    async release() {
      if (activeChild) {
        try { activeChild.kill("SIGKILL"); } catch {}
        activeChild = null;
      }
    },
    async shutdown() {
      await this.release();
    }
  };
}

// 6. Main Logs Buffer & IPC Handlers
const mainLogs = [];
function addMainLog(level, message) {
  mainLogs.push({
    id: mainLogs.length + 1,
    timestamp: new Date().toISOString(),
    level,
    source: "Electron",
    message: String(message)
  });
  if (mainLogs.length > 1000) mainLogs.shift();
}

let mainWindow = null;
let browserServerHandle = null;
let lastActivityAt = Date.now();

function registerIpcHandlers() {
  ipcMain.handle("app:get-device-info", () => getDeviceInfo());
  ipcMain.handle("app:is-window-active", () => {
    return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
  });
  ipcMain.handle("app:activity-report", () => ({
    recordActivity: true,
    activityOccurredAt: new Date(lastActivityAt).toISOString()
  }));
  ipcMain.handle("app:enable-devtools", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
    return { ok: true };
  });
  ipcMain.handle("app:disable-devtools", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.closeDevTools();
    }
    return { ok: true };
  });
  ipcMain.handle("app:open-external-url", async (_e, targetUrl) => {
    if (typeof targetUrl === "string" && /^https?:\/\//i.test(targetUrl)) {
      await shell.openExternal(targetUrl);
    }
    return { ok: true };
  });
  ipcMain.handle("app:select-video-output-dir", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"]
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true, path: null };
    return { canceled: false, path: res.filePaths[0] };
  });
  ipcMain.handle("app:select-save-file", async (_e, opts = {}) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: opts.defaultPath || "video.mp4",
      filters: opts.filters || [{ name: "MP4 Video", extensions: ["mp4"] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true, filePath: null };
    return { canceled: false, filePath: res.filePath };
  });
  ipcMain.handle("app:write-file", async (_e, filePath, data) => {
    if (!filePath || typeof filePath !== "string") throw new Error("invalid_path");
    const buf = Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, buf);
    return { ok: true, bytes: buf.length };
  });
  ipcMain.handle("app:copy-image-files-to-clipboard", async (_e, files = []) => {
    if (Array.isArray(files) && files.length > 0) {
      const first = files[0];
      if (first && first.data) {
        const buf = Buffer.isBuffer(first.data) ? first.data : Buffer.from(first.data);
        const img = nativeImage.createFromBuffer(buf);
        if (!img.isEmpty()) clipboard.writeImage(img);
      } else if (typeof first === "string" && fs.existsSync(first)) {
        const img = nativeImage.createFromPath(first);
        if (!img.isEmpty()) clipboard.writeImage(img);
      }
    }
    return { ok: true };
  });
  ipcMain.handle("app:get-main-logs", (_e, limit = 500) => mainLogs.slice(-limit));
  ipcMain.handle("app:clear-main-logs", () => {
    mainLogs.length = 0;
    return { ok: true };
  });

  // Installer cleanup stubs
  const idleCleanupState = { phase: "idle", runId: null, candidates: [], results: null };
  ipcMain.handle("installer-cleanup:state", () => idleCleanupState);
  ipcMain.handle("installer-cleanup:ready", () => idleCleanupState);
  ipcMain.handle("installer-cleanup:cancel", () => idleCleanupState);
  ipcMain.handle("installer-cleanup:dismiss", () => idleCleanupState);
  ipcMain.handle("installer-cleanup:confirm", () => idleCleanupState);

  // 1-Click In-App Auto-Updater (downloads patch .zip from Cloudflare Worker & extracts preserving user data!)
  let updateState = {
    phase: "idle",
    version: null,
    progress: 0,
    error: null,
    platform: "win32",
    quitAt: null
  };
  let activeUpdateAbort = null;

  const broadcastUpdateState = (patch) => {
    updateState = { ...updateState, ...patch, platform: "win32" };
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send("app:update-state", updateState);
      } catch {}
    }
    return updateState;
  };

  ipcMain.handle("app:update-status", () => updateState);

  ipcMain.handle("app:update-cancel", () => {
    if (activeUpdateAbort) {
      try {
        activeUpdateAbort.abort();
      } catch {}
      activeUpdateAbort = null;
    }
    return broadcastUpdateState({ phase: "idle", progress: 0, error: null });
  });

  ipcMain.handle("app:update-start", async (_e, targetVersion) => {
    const ver = String(targetVersion || "").trim() || "1.7.5";
    if (updateState.phase === "downloading" || updateState.phase === "checking") {
      return updateState;
    }
    activeUpdateAbort = new AbortController();
    broadcastUpdateState({ phase: "checking", version: ver, progress: 8, error: null });

    (async () => {
      try {
        // 1. Check downloadUrl from Cloudflare Worker
        let downloadUrl = `${licenseServerOrigin}/download-update.zip`;
        try {
          const checkRes = await fetch(`${licenseServerOrigin}/app-version/check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appVersion: "0.0.0" }),
            signal: activeUpdateAbort.signal
          });
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            if (checkData?.updateInfo?.downloadUrl) {
              downloadUrl = checkData.updateInfo.downloadUrl;
            }
          }
        } catch {}

        broadcastUpdateState({ phase: "downloading", version: ver, progress: 25, error: null });

        const dlRes = await fetch(downloadUrl, { signal: activeUpdateAbort.signal });
        if (!dlRes.ok) {
          throw new Error(`Không tải được gói cập nhật (HTTP ${dlRes.status}).`);
        }

        const arrayBuf = await dlRes.arrayBuffer();
        const zipBuf = Buffer.from(arrayBuf);
        if (zipBuf.length < 1024) {
          throw new Error("Gói cập nhật tải về không hợp lệ hoặc bị rỗng.");
        }

        broadcastUpdateState({ phase: "downloading", version: ver, progress: 70, error: null });

        const tmpZipPath = path.join(USER_DATA_DIR, `pain_update_${Date.now()}.zip`);
        const tmpExtractDir = path.join(USER_DATA_DIR, `pain_update_extract_${Date.now()}`);
        fs.writeFileSync(tmpZipPath, zipBuf);
        fs.mkdirSync(tmpExtractDir, { recursive: true });

        // Extract zip into tmpExtractDir and copy files into APP_ROOT (preserving app/ and .pain-aio-data/)
        const psCmd = `Expand-Archive -LiteralPath '${tmpZipPath.replace(/'/g, "''")}' -DestinationPath '${tmpExtractDir.replace(/'/g, "''")}' -Force`;
        await new Promise((resolve, reject) => {
          const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCmd], {
            windowsHide: true
          });
          child.on("error", reject);
          child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Giải nén thất bại (${code})`))));
        });

        broadcastUpdateState({ phase: "downloading", version: ver, progress: 90, error: null });

        // If the zip has a single top-level folder (e.g. PAIN-AiO/), unwrap it
        let copySourceRoot = tmpExtractDir;
        const topEntries = fs.readdirSync(tmpExtractDir, { withFileTypes: true });
        if (
          topEntries.length === 1 &&
          topEntries[0].isDirectory() &&
          !/^(electron|dist|browser-server-dist|PAIN-AiO-Runtime)$/i.test(topEntries[0].name)
        ) {
          copySourceRoot = path.join(tmpExtractDir, topEntries[0].name);
        }

        const copyRecursiveSafe = (srcDir, dstDir) => {
          const entries = fs.readdirSync(srcDir, { withFileTypes: true });
          for (const entry of entries) {
            const relFromRoot = path.relative(APP_ROOT, path.join(dstDir, entry.name)).replace(/\\/g, "/");
            // Never overwrite user's personal accounts or projects in app/ or .pain-aio-data/!
            if (relFromRoot === "app" || relFromRoot.startsWith("app/") || relFromRoot.startsWith(".pain-aio-data")) {
              continue;
            }
            const sPath = path.join(srcDir, entry.name);
            const dPath = path.join(dstDir, entry.name);
            if (entry.isDirectory()) {
              fs.mkdirSync(dPath, { recursive: true });
              copyRecursiveSafe(sPath, dPath);
            } else if (entry.isFile()) {
              try {
                fs.mkdirSync(path.dirname(dPath), { recursive: true });
                fs.copyFileSync(sPath, dPath);
              } catch {}
            }
          }
        };

        copyRecursiveSafe(copySourceRoot, APP_ROOT);

        // Update package.json version to the new version
        try {
          const pkgPath = path.join(APP_ROOT, "package.json");
          const pkgObj = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          pkgObj.version = ver;
          fs.writeFileSync(pkgPath, JSON.stringify(pkgObj, null, 2), "utf8");
          PKG_JSON.version = ver;
        } catch {}

        try {
          fs.rmSync(tmpExtractDir, { recursive: true, force: true });
          fs.unlinkSync(tmpZipPath);
        } catch {}

        broadcastUpdateState({ phase: "ready", version: ver, progress: 100, error: null });
      } catch (err) {
        if (err.name === "AbortError") return;
        broadcastUpdateState({
          phase: "failed",
          version: ver,
          progress: 0,
          error: err.message || "Lỗi tải bản cập nhật."
        });
      } finally {
        activeUpdateAbort = null;
      }
    })();

    return updateState;
  });

  ipcMain.handle("app:update-install", async () => {
    try {
      try {
        await browserServerHandle?.close?.();
      } catch {}
      const launcherExe = path.join(APP_ROOT, "PAIN-AiO.exe");
      if (fs.existsSync(launcherExe)) {
        spawn(launcherExe, [], {
          cwd: APP_ROOT,
          detached: true,
          stdio: "ignore"
        }).unref();
      } else {
        app.relaunch();
      }
      setTimeout(() => {
        app.exit(0);
      }, 150);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// 7. Bootstrap Browser Server & Create Window
function relocatePortableAccountPaths() {
  for (const dataRoot of [path.join(APP_ROOT, "app"), USER_DATA_DIR]) {
    const accFile = path.join(dataRoot, "accounts.json");
    if (!fs.existsSync(accFile)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(accFile, "utf8"));
      if (parsed && Array.isArray(parsed.accounts)) {
        let changed = false;
        for (const a of parsed.accounts) {
          if (a && a.id && a.provider) {
            const expectedDir = path.join(dataRoot, "accounts", a.provider, a.id);
            if (a.profileDir !== expectedDir) {
              a.profileDir = expectedDir;
              changed = true;
            }
          }
        }
        if (changed) {
          fs.writeFileSync(accFile, JSON.stringify(parsed, null, 2), "utf8");
        }
      }
    } catch {}
  }
}

async function bootstrap() {
  relocatePortableAccountPaths();
  registerIpcHandlers();
  addMainLog("info", `Connected to Cloud License Server at ${licenseServerOrigin}`);

  // Set environment variables before importing browser-server-dist/index.js
  process.env.GENERATION_LEASE_PUBLIC_KEY = keypair.publicKeyPem;
  process.env.LICENSE_API_ORIGIN = licenseServerOrigin;
  process.env.APP_RESOURCES_PATH = APP_ROOT;
  process.env.VEO3_FLOW_EXECUTION_MODE = process.env.VEO3_FLOW_EXECUTION_MODE || "api";
  process.env.APP_BACKGROUND_BROWSER = process.env.APP_BACKGROUND_BROWSER || "1";
  process.env.APP_EXTERNAL_BROWSER_HIDE_STRICT = process.env.APP_EXTERNAL_BROWSER_HIDE_STRICT || "1";
  process.env.GROK_EMBEDDED_BROWSER = process.env.GROK_EMBEDDED_BROWSER || "1";
  process.env.GROK_EXTERNAL_BROWSER_HIDE = process.env.GROK_EXTERNAL_BROWSER_HIDE || "1";
  process.env.VEO3_EMBEDDED_BROWSER = process.env.VEO3_EMBEDDED_BROWSER || "0";
  process.env.VEO3_EXTERNAL_BROWSER_HIDE = process.env.VEO3_EXTERNAL_BROWSER_HIDE || "0";
  process.env.VEO3_RECYCLE_AFTER_SUCCESS = process.env.VEO3_RECYCLE_AFTER_SUCCESS || "0";
  process.env.VEO3_RECYCLE_DELAY_MS = process.env.VEO3_RECYCLE_DELAY_MS || "2000";
  process.env.VEO3_DEBUG_WORKER_WINDOW = process.env.VEO3_DEBUG_WORKER_WINDOW || "0";
  process.env.VEO3_FAKE_RECAPTCHA_ON_DIRECT = process.env.VEO3_FAKE_RECAPTCHA_ON_DIRECT || "0";

  const sessionToken = crypto.randomBytes(32).toString("hex");
  const secretCodec = createSecretCodec();
  const voiceHost = createVoiceRuntimeHost();

  const bsModuleUrl = pathToFileURL(path.join(APP_ROOT, "browser-server-dist", "index.js")).href;
  const { startBrowserServer } = await import(bsModuleUrl);

  browserServerHandle = await startBrowserServer({
    sessionToken,
    allowedOrigins: ["null", "file://", "http://localhost:5173", "http://127.0.0.1:3001"],
    recaptchaAssetSource: (name) => recaptchaAssets[name] || null,
    gptSecretCodec: secretCodec,
    voiceSecretCodec: secretCodec,
    voiceRuntimeHost: voiceHost,
    autoLaunchBrowser: false
  });

  const apiOrigin = browserServerHandle.origin || "http://127.0.0.1:3001";
  addMainLog("info", `Browser server ready at ${apiOrigin}`);

  // Automatically attach X-Phoma-Local-Session header to all requests from the renderer to apiOrigin
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${apiOrigin}/*`, "http://127.0.0.1:3001/*"] },
    (details, callback) => {
      const requestHeaders = {
        ...details.requestHeaders,
        "X-Phoma-Local-Session": sessionToken
      };
      callback({ requestHeaders });
    }
  );

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: `PAIN-AiO v${PKG_JSON.version || "1.7.4"}`,
    icon: path.join(__dirname, "icon.ico"),
    backgroundColor: "#09090b",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--app-api-origin=${apiOrigin}`,
        `--license-api-origin=${licenseServerOrigin}`,
        `--app-version=${PKG_JSON.version || "1.7.4"}`,
        `--app-name=PAIN-AiO`
      ]
    }
  });
  try {
    mainWindow.setIcon(path.join(__dirname, "icon.ico"));
  } catch {}

  // Log renderer console messages and load errors to .pain-aio-data/startup-debug.log
  const debugLogPath = path.join(USER_DATA_DIR, "startup-debug.log");
  const writeDebug = (msg) => {
    try {
      fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
  };
  writeDebug(`Main window created. apiOrigin=${apiOrigin}, licenseOrigin=${licenseServerOrigin}`);

  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    writeDebug(`[Renderer Console L${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    writeDebug(`[Renderer did-fail-load] code=${code} desc=${desc} url=${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    writeDebug(`[Renderer gone] ${JSON.stringify(details)}`);
  });

  // Clear any legacy offline dummy token so the real Cloud Login + 1-Device HWID verification runs
  mainWindow.webContents.on("dom-ready", async () => {
    writeDebug("[Renderer dom-ready] fired");
    try {
      await mainWindow.webContents.executeJavaScript(`
        try {
          if (localStorage.getItem("phoma_license_access_token") === ${JSON.stringify(LEGACY_OFFLINE_TOKEN)}) {
            localStorage.removeItem("phoma_license_access_token");
            localStorage.removeItem("phoma_license_session_cache");
          }
        } catch (e) {}
      `);
    } catch {}
  });

  mainWindow.webContents.on("did-finish-load", async () => {
    writeDebug("[Renderer did-finish-load] fired");
    setTimeout(async () => {
      try {
        const htmlSnap = await mainWindow.webContents.executeJavaScript(`({
          url: location.href,
          rootHtml: document.getElementById("root")?.innerHTML?.slice(0, 500),
          bodyBg: getComputedStyle(document.body).backgroundColor
        })`);
        writeDebug(`[Renderer DOM Snapshot after 2s] ${JSON.stringify(htmlSnap)}`);
      } catch (e) {
        writeDebug(`[Renderer DOM Snapshot err] ${e.message}`);
      }
    }, 2000);
  });

  mainWindow.webContents.on("before-input-event", () => {
    lastActivityAt = Date.now();
  });

  await mainWindow.loadFile(path.join(APP_ROOT, "dist", "index.html"));
}

app.whenReady().then(bootstrap).catch((err) => {
  try {
    fs.appendFileSync(path.join(USER_DATA_DIR, "startup-debug.log"), `[FATAL] ${err.stack || err}\n`);
  } catch {}
  console.error("[Main] Fatal startup error:", err);
});

app.on("window-all-closed", async () => {
  try {
    await browserServerHandle?.close?.();
  } catch {}
  app.quit();
});
