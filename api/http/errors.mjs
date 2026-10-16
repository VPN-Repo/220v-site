import {
  formatOtpResendCooldownMessage,
  isTimeoutError,
  publicMessageFromErr,
  timeoutStatusCode,
} from "./userMessages.mjs";

export function clientError(res, status, message, extra) {
  if (extra && typeof extra === "object") {
    return res.status(status).json({ error: message, ...extra });
  }
  return res.status(status).json({ error: message });
}

export function serverError(res, req, err, publicMessage = "Внутренняя ошибка сервера") {
  const message = publicMessageFromErr(err, publicMessage);
  req.log?.error({ err }, publicMessage);
  return res.status(timeoutStatusCode(err)).json({ error: message });
}

// A resend refused by the OTP cooldown: the client can tell the user exactly when to retry.
export function otpCooldownError(res, retryAfterSec) {
  const sec = Math.max(1, Math.ceil(retryAfterSec));
  res.set("Retry-After", String(sec));
  return clientError(res, 429, formatOtpResendCooldownMessage(sec), {
    retryAfterSec: sec,
    code: "otp_cooldown",
  });
}
