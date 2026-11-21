import crypto from "node:crypto";

export const ACCESS_ERROR_CODES = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  LICENSE_REQUIRED: "LICENSE_REQUIRED",
  DEVICE_MISMATCH: "DEVICE_MISMATCH"
};

export function validateGenerationLease(rawLease, deviceInfo, accessToken, publicKeyPem, nowMs = Date.now()) {
  if (!rawLease || typeof rawLease !== "string") {
    return {
      code: ACCESS_ERROR_CODES.LICENSE_REQUIRED,
      message: "Quyền tạo nội dung không hợp lệ. Vui lòng kết nối lại để kiểm tra license."
    };
  }
  const parts = rawLease.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return {
      code: ACCESS_ERROR_CODES.LICENSE_REQUIRED,
      message: "Quyền tạo nội dung không hợp lệ. Vui lòng kết nối lại để kiểm tra license."
    };
  }
  try {
    if (publicKeyPem) {
      const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
      const signature = Buffer.from(parts[2], "base64url");
      const verified = crypto.verify(null, signingInput, publicKeyPem, signature);
      if (!verified) {
        return {
          code: ACCESS_ERROR_CODES.LICENSE_REQUIRED,
          message: "Quyền tạo nội dung không hợp lệ. Vui lòng kết nối lại để kiểm tra license."
        };
      }
    }
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (
      !claims ||
      claims.type !== "generation_access" ||
      String(claims.licenseStatus || "").toLowerCase() !== "active"
    ) {
      return {
        code: ACCESS_ERROR_CODES.LICENSE_REQUIRED,
        message: "Quyền tạo nội dung không hợp lệ. Vui lòng kết nối lại để kiểm tra license."
      };
    }
    if (Number.isFinite(nowMs) && typeof claims.exp === "number" && claims.exp * 1000 <= nowMs) {
      return {
        code: ACCESS_ERROR_CODES.LICENSE_REQUIRED,
        message: "Quyền tạo nội dung đã hết hạn. Vui lòng kết nối lại để kiểm tra license."
      };
    }
    if (accessToken) {
      const expectedTokenHash = crypto.createHash("sha256").update(accessToken, "utf8").digest("hex");
      if (claims.accessTokenHash !== expectedTokenHash) {
        return {
          code: ACCESS_ERROR_CODES.AUTH_REQUIRED,
          message: "Phiên đăng nhập không khớp với quyền tạo nội dung."
        };
      }
    }
    if (deviceInfo && deviceInfo.machineId && deviceInfo.installationId) {
      const expectedBinding = crypto
        .createHash("sha256")
        .update(`${deviceInfo.machineId}:${deviceInfo.installationId}`, "utf8")
        .digest("hex");
      if (claims.deviceBinding !== expectedBinding) {
        return {
          code: ACCESS_ERROR_CODES.DEVICE_MISMATCH,
          message: "Thiết bị không khớp với quyền tạo được cấp."
        };
      }
    }
    return null;
  } catch {
    return {
      code: ACCESS_ERROR_CODES.LICENSE_REQUIRED,
      message: "Quyền tạo nội dung không hợp lệ. Vui lòng kết nối lại để kiểm tra license."
    };
  }
}
