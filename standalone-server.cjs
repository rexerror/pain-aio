#!/usr/bin/env node
"use strict";

/**
 * Standalone Server Runner for Phoma Local Clone
 * Starts Local License Server + Browser Server + Static UI Server
 * so you can also open http://127.0.0.1:5173 in any browser or verify full UI flow!
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const APP_ROOT = __dirname;
const keypair = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "electron/local-ed25519-keypair.json"), "utf8"));
const recaptchaAssets = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "electron/recaptcha-assets.json"), "utf8"));
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));

const INSTALLATION_ID = "local-clone-installation-001";
const MACHINE_ID = "local-clone-machine-001";
const LOCAL_ACCESS_TOKEN = "phoma-local-pro-unlimited-access-token";

function getDeviceInfo() {
  return {
    installationId: INSTALLATION_ID,
    machineId: MACHINE_ID,
    deviceName: os.hostname() || "Phoma-Local-PC",
    os: process.platform,
    osVersion: os.release(),
    arch: process.arch,
    appVersion: PKG_JSON.version || "1.7.4"
  };
}

function issueSignedGenerationLease(deviceInfo = getDeviceInfo(), accessToken = LOCAL_ACCESS_TOKEN) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + 86400 * 365;
  const accessTokenHash = crypto.createHash("sha256").update(accessToken, "utf8").digest("hex");
  const deviceBinding = crypto
    .createHash("sha256")
    .update(`${deviceInfo.machineId}:${deviceInfo.installationId}`, "utf8")
    .digest("hex");

  const claims = {
    type: "generation_access",
    sub: "local-pro-user",
    accessTokenHash,
    deviceBinding,
    licenseStatus: "active",
    exp: expSec
  };

  const prefix = "v1";
  const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = Buffer.from(`${prefix}.${payloadB64}`, "utf8");
  const sigB64 = crypto.sign(null, signingInput, keypair.privateKeyPem).toString("base64url");

  return {
    generationLease: `${prefix}.${payloadB64}.${sigB64}`,
    leaseExpiresAt: new Date(expSec * 1000).toISOString()
  };
}

function buildActiveSessionPayload(deviceInfo = getDeviceInfo(), accessToken = LOCAL_ACCESS_TOKEN) {
  const { generationLease, leaseExpiresAt } = issueSignedGenerationLease(deviceInfo, accessToken);
  return {
    accessToken,
    user: {
      id: "local-pro-user",
      username: "local_pro",
      displayName: "Phoma Pro (Local Clone)",
      role: "debug"
    },
    license: {
      status: "active",
      accessUntil: "2099-12-31T23:59:59.000Z",
      currentPlanCode: "PRO_UNLIMITED",
      currentPlanName: "Pro Unlimited (Local Clone)",
      lastCheckedAt: new Date().toISOString(),
      nextCheckAt: "2099-12-31T23:59:59.000Z",
      reason: null,
      updateInfo: null
    },
    device: {
      deviceId: deviceInfo.installationId,
      deviceName: deviceInfo.deviceName,
      status: "active"
    },
    generationLease,
    leaseExpiresAt,
    updateInfo: null
  };
}

async function main() {
  const licServer = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
      const urlPath = (req.url || "/").split("?")[0];
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim() || LOCAL_ACCESS_TOKEN;
      const devInfo = body.deviceInfo || getDeviceInfo();
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (urlPath === "/session/generation-lease/verify") {
        res.end(JSON.stringify({ ok: true, remainingMs: 900000 }));
      } else if (urlPath === "/app-version/check") {
        res.end(JSON.stringify({ updateInfo: null }));
      } else if (urlPath === "/notifications") {
        res.end(JSON.stringify([]));
      } else {
        res.end(JSON.stringify(buildActiveSessionPayload(devInfo, token)));
      }
    });
  });

  await new Promise(r => licServer.listen(0, "127.0.0.1", r));
  const licOrigin = `http://127.0.0.1:${licServer.address().port}`;

  process.env.GENERATION_LEASE_PUBLIC_KEY = keypair.publicKeyPem;
  process.env.LICENSE_API_ORIGIN = licOrigin;
  process.env.APP_RESOURCES_PATH = APP_ROOT;

  const sessionToken = crypto.randomBytes(32).toString("hex");
  const codec = {
    encrypt: s => Buffer.from(String(s)).toString("base64"),
    decrypt: s => Buffer.from(String(s), "base64").toString("utf8")
  };

  const bsUrl = pathToFileURL(path.join(APP_ROOT, "browser-server-dist/index.js")).href;
  const { startBrowserServer } = await import(bsUrl);

  const bsHandle = await startBrowserServer({
    sessionToken,
    allowedOrigins: ["null", "http://127.0.0.1:5173", "http://localhost:5173"],
    recaptchaAssetSource: name => recaptchaAssets[name] || null,
    gptSecretCodec: codec,
    voiceSecretCodec: codec,
    voiceRuntimeHost: { isAvailable: async () => true, cudaRuntimeAssets: async () => [] },
    autoLaunchBrowser: false
  });

  console.log(`[Standalone] Local License Server: ${licOrigin}`);
  console.log(`[Standalone] Browser Server: ${bsHandle.origin}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
