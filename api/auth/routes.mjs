import { Router } from "express";
import { randomBytes } from "node:crypto";
import { ALLOWED_EMAIL_DOMAINS, OTP_COOLDOWN_SEC, OTP_MAX_TRIES, OTP_TTL_SEC, SESSION_TTL_SEC } from "../config.mjs";
import { clientError, otpCooldownError, serverError } from "../http/errors.mjs";
import {
  isTimeoutError,
  publicMessageFromErr,
  timeoutStatusCode,
} from "../http/userMessages.mjs";
import { redis } from "../redis.mjs";
import {
  sendCodeIpHourLimiter,
  sendCodeIpMinuteLimiter,
  sendCodeEmailLimiter,
  verifyIpLimiter,
  authMethodLimiter,
  passwordIpLimiter,
  passwordEmailLimiter,
  passwordChangeEmailLimiter,
  passwordChangeAttemptLimiter,
  adminPasswordLimiter,
} from "../http/rateLimit.mjs";
import {
  base64url,
  emailHash,
  generateOtpCode,
  hashCode,
  maskEmail,
} from "./crypto.mjs";
import {
  buildRedisAuthSnapshot,
  findLatestSuccessfulSendCodeEvent,
  recordAuthEvent,
} from "./events.mjs";
import {
  acquireOtpCooldown,
  clearOtpAndCooldown,
  cooldownRemainingSec,
  deleteOtp,
  getCooldownDebugSnapshot,
  getOtpDebugSnapshot,
  pickOtpMailProvider,
  putOtp,
  recordOtpMailSend,
  verifyOtp,
} from "./otp.mjs";
import {
  adminSetPasswordSchema,
  emailSchema,
  methodSchema,
  passwordChangeSchema,
  passwordLoginSchema,
  sendCodeSchema,
  verifySchema,
} from "./schemas.mjs";
import {
  adminSetPassword,
  changePassword,
  credentialVersion,
  getCredential,
  hashPassword,
  saveInitialPassword,
  saveLoginSession,
  verifyPassword,
} from "./password.mjs";
import {
  otpCooldownKey,
  otpMailSendsKey,
  passwordCooldownKey,
  passwordMailSendsKey,
  passwordOtpKey,
} from "./keys.mjs";
import { listDailyUnfinishedEmails, recordDailyAuth } from "./dailyStats.mjs";
import { recordReferralEvent } from "../referrals/events.mjs";
import {
  clearSessionCookies,
  deleteSession,
  requireAdminToken,
  requireSession,
  setSessionCookies,
} from "./session.mjs";

/**
 * @param {{ mailer: { sendOtpEmail: (opts: { email: string, code: string, purpose?: "login" | "password_change", provider?: "primary" | "backup" }) => Promise<{ ok: boolean, error?: string, detail?: string, messageId?: string, provider?: string, failover?: boolean }> }, loadUserProfile: (email: string, req: import('express').Request, refUuid?: string, options?: { enrich?: boolean }) => Promise<object>, extractUserUuid: (profile: object) => string | null, isReferralPointsBlocked?: (refUuid: string) => Promise<boolean> }} deps
 */
export function createAuthRouter({ mailer, loadUserProfile, extractUserUuid, isReferralPointsBlocked }) {
  const router = Router();

  // The first OTP email in the window goes through SES, a resend through the
  // backup SMTP. Redis trouble here must not block sending: fall back to primary.
  const chooseMailProvider = async (req, sendsKey) => {
    try {
      return await pickOtpMailProvider(sendsKey);
    } catch (err) {
      req.log.warn({ err }, "otp mail provider lookup failed");
      return "primary";
    }
  };
  // Counted only after a provider accepted the email; a counter failure must
  // not turn an already delivered code into an error response.
  // Returns which send this is in the window, or null when it is unknown.
  const countMailSend = async (req, sendsKey) => {
    try {
      return await recordOtpMailSend(sendsKey);
    } catch (err) {
      req.log.warn({ err }, "otp mail send counter update failed");
      return null;
    }
  };
  // The client says "code sent again (N-th send)" from sendNumber.
  const sendCodeOk = (sendNumber) =>
    sendNumber ? { ok: true, retryAfterSec: OTP_COOLDOWN_SEC, sendNumber } : { ok: true, retryAfterSec: OTP_COOLDOWN_SEC };

  router.get("/api/admin/redis-auth", requireAdminToken, async (req, res) => {
    try {
      const snapshot = await buildRedisAuthSnapshot();
      return res.json(snapshot);
    } catch (err) {
      return serverError(res, req, err, "Не удалось загрузить данные Redis");
    }
  });

  router.get("/api/admin/redis-auth/unfinished", requireAdminToken, async (req, res) => {
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return clientError(res, 400, "Некорректная страница списка");
    }
    try {
      res.set("Cache-Control", "no-store");
      return res.json(await listDailyUnfinishedEmails({ offset, limit }));
    } catch (err) {
      return serverError(res, req, err, "Не удалось загрузить email");
    }
  });

  // Support assigns a password when the user owns the account but cannot receive email codes.
  router.post("/api/admin/set-password", adminPasswordLimiter, requireAdminToken, async (req, res) => {
    try {
      const parsed = adminSetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return clientError(res, 400, parsed.error.issues[0]?.message || "Некорректный email или пароль");
      }
      const { email, password } = parsed.data;
      let profile;
      try {
        profile = await loadUserProfile(email, req, undefined, { enrich: false });
      } catch (err) {
        req.log.warn({ err, emailHash: emailHash(email) }, "admin set-password profile failed");
        return clientError(res, err.status === 404 ? 404 : 502, "Не удалось загрузить аккаунт");
      }
      const userUuid = extractUserUuid(profile);
      if (!userUuid || profile?.exists === false) {
        return clientError(res, 404, "Аккаунт с таким email не найден");
      }
      const version = await adminSetPassword(email, userUuid, await hashPassword(password));
      await recordAuthEvent("password_set_by_admin", req, { email, userUuid, status: "ok" });
      return res.json({ ok: true, version });
    } catch (err) {
      return serverError(res, req, err);
    }
  });

  router.post("/api/auth/method", authMethodLimiter, async (req, res) => {
    try {
      const parsed = methodSchema.safeParse(req.body);
      if (!parsed.success) return clientError(res, 400, "Некорректный email");
      return res.json({ hasPassword: Boolean(await getCredential(parsed.data.email)) });
    } catch (err) {
      return serverError(res, req, err);
    }
  });

  router.post("/api/auth/login-password", passwordIpLimiter, passwordEmailLimiter, async (req, res) => {
    try {
      const parsed = passwordLoginSchema.safeParse(req.body);
      if (!parsed.success) return clientError(res, 400, "Некорректный запрос");
      const { email, password } = parsed.data;
      const credential = await getCredential(email);
      // verifyPassword always runs scrypt, so unknown emails take as long as wrong passwords.
      if (!(await verifyPassword(password, credential))) {
        await recordAuthEvent("password_login_failed", req, { email, status: "failed" });
        return clientError(res, 401, "Неверный email или пароль");
      }

      let profile;
      try {
        profile = await loadUserProfile(email, req);
      } catch (err) {
        const status = isTimeoutError(err) ? timeoutStatusCode(err) : err.status || 502;
        req.log.warn({ err, emailHash: emailHash(email) }, "password login profile failed");
        await recordAuthEvent("password_profile_failed", req, { email, status: "failed" });
        return clientError(
          res,
          status,
          publicMessageFromErr(err, "Не удалось завершить вход", { context: "авторизация" }),
        );
      }

      const userUuid = extractUserUuid(profile);
      if (!userUuid || userUuid !== credential.userUuid) {
        await recordAuthEvent("password_profile_invalid", req, { email, status: "failed" });
        return clientError(res, 502, "Не удалось завершить вход");
      }

      const sid = base64url(randomBytes(32));
      const csrf = base64url(randomBytes(32));
      const expAt = Date.now() + SESSION_TTL_SEC * 1000;
      const session = { userUuid, email, csrf, expAt, authVersion: credential.version };
      const outcome = await saveLoginSession(email, userUuid, credential.version, sid, session, SESSION_TTL_SEC);
      if (outcome !== "ok") return clientError(res, 409, "Пароль был изменён. Повторите вход");
      setSessionCookies(res, sid, csrf);

      req.log.info(
        { emailHash: emailHash(email), userUuidPrefix: userUuid.slice(0, 8) },
        "password login ok",
      );
      await recordAuthEvent("login_ok", req, { email, userUuid, status: "ok" });
      return res.json(profile);
    } catch (err) {
      return serverError(res, req, err);
    }
  });

  router.post(
    "/api/auth/send-code",
    sendCodeIpMinuteLimiter,
    sendCodeIpHourLimiter,
    sendCodeEmailLimiter,
    async (req, res) => {
      try {
        const parsed = sendCodeSchema.safeParse(req.body);
        if (!parsed.success) {
          await recordAuthEvent("send_code_invalid_request", req, { status: "rejected" });
          return clientError(res, 400, "Некорректный email");
        }
        const email = parsed.data.email;
        const atIdx = email.indexOf("@");
        const localPart = email.slice(0, atIdx);
        const domain = email.slice(atIdx + 1);

        if (localPart.includes("+")) {
          return clientError(
            res,
            400,
            "Email не должен содержать плюс в имени",
          );
        }

        if (!ALLOWED_EMAIL_DOMAINS.has(domain)) {
          return clientError(
            res,
            400,
            "Этот домен не поддерживается, используйте популярные почтовые сервисы - gmail.com, yandex.ru, mail.ru и тд.",
          );
        }

        const owner = base64url(randomBytes(16));
        const cooldownResult = await acquireOtpCooldown(email, owner, OTP_COOLDOWN_SEC);
        if (cooldownResult !== "OK") {
          await recordAuthEvent("send_code_cooldown", req, { email, status: "rejected" });
          return otpCooldownError(res, await cooldownRemainingSec(otpCooldownKey(email)));
        }

        const code = generateOtpCode();
        const hash = hashCode(code);
        const authVersion = credentialVersion(await getCredential(email));
        await putOtp(email, hash, owner, authVersion);
        const [otpDebug, cooldownDebug] = await Promise.all([
          getOtpDebugSnapshot(email),
          getCooldownDebugSnapshot(email),
        ]);
        req.log.info(
          {
            emailHash: emailHash(email),
            redisStatus: redis.status,
            otpTtlSec: otpDebug.ttlSec,
            cooldownTtlSec: cooldownDebug.ttlSec,
          },
          "otp stored",
        );

        const sendsKey = otpMailSendsKey(email);
        const requestedProvider = await chooseMailProvider(req, sendsKey);
        const mailResult = await mailer.sendOtpEmail({ email, code, provider: requestedProvider });

        if (!mailResult.ok) {
          await clearOtpAndCooldown(email, owner);
          await recordAuthEvent("send_code_mail_failed", req, { email, status: "failed" });
          req.log.warn(
            {
              emailHash: emailHash(email),
              maskedEmail: maskEmail(email),
              recipientDomain: domain,
              mailerError: mailResult.error,
              mailerDetail: mailResult.detail,
              requestedProvider,
            },
            "send-code mailer failed",
          );
          return res.status(502).json({ error: "Не удалось отправить код" });
        }

        const sendNumber = await countMailSend(req, sendsKey);
        req.log.info(
          {
            emailHash: emailHash(email),
            messageId: mailResult.messageId,
            requestedProvider,
            provider: mailResult.provider,
            failover: mailResult.failover,
          },
          "send-code dispatched",
        );
        await recordAuthEvent("send_code_sent", req, {
          email,
          status: "ok",
          provider: mailResult.provider,
          failover: mailResult.failover,
        });
        await recordDailyAuth("sent", email, req);

        if (parsed.data.ref_uuid) {
          await recordReferralEvent("ref_send_code", req, {
            referrerUuid: parsed.data.ref_uuid,
            referredEmailHash: emailHash(email),
            fingerprint: parsed.data.fingerprint,
          });
        }

        return res.json(sendCodeOk(sendNumber));
      } catch (err) {
        return serverError(res, req, err);
      }
    },
  );

  router.post("/api/auth/verify", verifyIpLimiter, async (req, res) => {
    try {
      const attemptEmail = emailSchema.safeParse(req.body?.email);
      const submittedCode = req.body?.code;
      if (
        attemptEmail.success &&
        (typeof submittedCode === "string" || typeof submittedCode === "number") &&
        String(submittedCode).trim()
      ) {
        await recordDailyAuth("attempted", attemptEmail.data, req);
      }
      const parsed = verifySchema.safeParse(req.body);
      if (!parsed.success) {
        await recordAuthEvent("verify_invalid_request", req, { status: "rejected" });
        const passwordIssue = parsed.error.issues.find((issue) => issue.path[0] === "newPassword");
        return clientError(res, 400, passwordIssue?.message || "Некорректный запрос");
      }
      const { email, code } = parsed.data;

      const otpResult = await verifyOtp(email, code);
      if (!otpResult.ok) {
        const eventMap = {
          missing: "verify_code_missing",
          corrupt: "verify_code_corrupt",
          too_many_tries: "verify_too_many_tries",
          bad_code: "verify_bad_code",
        };
        await recordAuthEvent(eventMap[otpResult.reason] || "verify_bad_code", req, {
          email,
          status: "failed",
        });
        if (otpResult.reason === "missing" || otpResult.reason === "corrupt") {
          const [otpDebug, cooldownDebug, latestSuccessfulSendCode] = await Promise.all([
            getOtpDebugSnapshot(email),
            getCooldownDebugSnapshot(email),
            findLatestSuccessfulSendCodeEvent(email),
          ]);
          req.log.warn(
            {
              emailHash: emailHash(email),
              reason: otpResult.reason,
              redisStatus: redis.status,
              otp: otpDebug,
              cooldown: cooldownDebug,
              latestSuccessfulSendCode,
            },
            "otp verify unavailable",
          );
        }
        if (otpResult.reason === "bad_code" && otpResult.tries) {
          req.log.warn({ emailHash: emailHash(email), tries: otpResult.tries }, "otp verify failed");
        }
        const messages = {
          missing: "Код истёк или не найден",
          corrupt: "Код истёк или не найден",
          too_many_tries: "Слишком много попыток. Запросите новый код.",
          bad_code: "Неверный код",
        };
        if (otpResult.reason === "bad_code" && otpResult.tries) {
          const attemptsLeft = Math.max(0, OTP_MAX_TRIES - otpResult.tries);
          // The attempt number and how many are left, so the user knows when the code burns out.
          return clientError(
            res,
            otpResult.status,
            `Неверный код. Осталось попыток: ${attemptsLeft} из ${OTP_MAX_TRIES}`,
            { attempt: otpResult.tries, attemptsLeft, maxAttempts: OTP_MAX_TRIES },
          );
        }
        return clientError(res, otpResult.status, messages[otpResult.reason] || "Неверный код");
      }

      await recordDailyAuth("confirmed", email, req);

      const newPassword = parsed.data.newPassword;
      if (newPassword && otpResult.authVersion !== 0) {
        return clientError(res, 409, "Пароль уже задан. Войдите и измените его в личном кабинете");
      }

      const referrerUuid = parsed.data.ref_uuid;
      let referralBlocked = false;
      if (referrerUuid && isReferralPointsBlocked) {
        try {
          referralBlocked = await isReferralPointsBlocked(referrerUuid);
        } catch (err) {
          req.log.warn({ err, referrerUuid }, "referral blocked status check failed");
        }
      }

      let profile;
      try {
        profile = await loadUserProfile(email, req, referralBlocked ? undefined : referrerUuid);
      } catch (err) {
        const status = isTimeoutError(err) ? timeoutStatusCode(err) : err.status || 502;
        await recordAuthEvent("verify_profile_failed", req, { email, status: "failed" });
        return clientError(
          res,
          status,
          publicMessageFromErr(err, "Не удалось завершить вход", { context: "авторизация" }),
        );
      }

      const userUuid = extractUserUuid(profile);
      if (!userUuid) {
        await recordAuthEvent("verify_profile_invalid", req, { email, status: "failed" });
        return clientError(res, 502, "Не удалось завершить вход");
      }

      const sid = base64url(randomBytes(32));
      const csrf = base64url(randomBytes(32));
      const expAt = Date.now() + SESSION_TTL_SEC * 1000;
      const session = {
        userUuid,
        email,
        csrf,
        expAt,
        authVersion: otpResult.authVersion + (newPassword ? 1 : 0),
      };

      // The session is written only if the password credential is still the
      // version the code was issued for (and, for a new password, still absent).
      const outcome = newPassword
        ? await saveInitialPassword(
            email,
            sid,
            { userUuid, version: 1, ...(await hashPassword(newPassword)) },
            session,
            SESSION_TTL_SEC,
          )
        : await saveLoginSession(email, userUuid, otpResult.authVersion, sid, session, SESSION_TTL_SEC);
      if (outcome !== "ok") {
        await deleteOtp(email);
        await recordAuthEvent("verify_auth_changed", req, { email, status: "failed" });
        return clientError(res, 409, "Данные входа изменились. Запросите новый код");
      }
      setSessionCookies(res, sid, csrf);
      await deleteOtp(email);
      if (newPassword) {
        await recordAuthEvent("password_set", req, { email, userUuid, status: "ok" });
      }

      req.log.info(
        { emailHash: emailHash(email), userUuidPrefix: userUuid.slice(0, 8) },
        "login ok",
      );
      await recordAuthEvent("login_ok", req, { email, userUuid, status: "ok" });

      if (referrerUuid) {
        const refCredit = profile?.referrer_credit || profile?.user?.referrer_credit;
        if (referralBlocked) {
          await recordReferralEvent("ref_credit_skipped", req, {
            referrerUuid,
            referredEmailHash: emailHash(email),
            referredUuidPrefix: userUuid.slice(0, 8),
            reason: "referrer_points_blocked",
            selfReferral: referrerUuid === userUuid,
            fingerprint: parsed.data.fingerprint,
          });
        } else if (refCredit && refCredit.credited === false) {
          await recordReferralEvent("ref_credit_skipped", req, {
            referrerUuid,
            referredEmailHash: emailHash(email),
            referredUuidPrefix: userUuid.slice(0, 8),
            reason: refCredit.reason || "unknown",
            selfReferral: referrerUuid === userUuid,
            fingerprint: parsed.data.fingerprint,
          });
        } else if (referrerUuid === userUuid) {
          await recordReferralEvent("ref_self_referral", req, {
            referrerUuid,
            referredEmailHash: emailHash(email),
            referredUuidPrefix: userUuid.slice(0, 8),
            selfReferral: true,
            fingerprint: parsed.data.fingerprint,
          });
        } else {
          await recordReferralEvent("ref_verify_ok", req, {
            referrerUuid,
            referredEmailHash: emailHash(email),
            referredUuidPrefix: userUuid.slice(0, 8),
            fingerprint: parsed.data.fingerprint,
          });
        }
      }

      return res.json(profile);
    } catch (err) {
      return serverError(res, req, err);
    }
  });

  router.post(
    "/api/auth/password/send-code",
    requireSession,
    sendCodeIpMinuteLimiter,
    passwordChangeEmailLimiter,
    async (req, res) => {
      try {
        const { sid, email } = req.session;
        const owner = base64url(randomBytes(16));
        const cooldown = passwordCooldownKey(sid);
        if ((await redis.set(cooldown, owner, "EX", OTP_COOLDOWN_SEC, "NX")) !== "OK") {
          return otpCooldownError(res, await cooldownRemainingSec(cooldown));
        }

        const code = generateOtpCode();
        await redis.set(
          passwordOtpKey(sid),
          JSON.stringify({
            hash: hashCode(code),
            tries: 0,
            authVersion: credentialVersion(await getCredential(email)),
            owner,
          }),
          "EX",
          OTP_TTL_SEC,
        );

        // Keyed per session, like the cooldown of this flow.
        const sendsKey = passwordMailSendsKey(sid);
        const requestedProvider = await chooseMailProvider(req, sendsKey);
        const mailResult = await mailer.sendOtpEmail({
          email,
          code,
          purpose: "password_change",
          provider: requestedProvider,
        });
        if (!mailResult.ok) {
          const existing = await redis.get(passwordOtpKey(sid));
          if (existing && JSON.parse(existing).owner === owner) await redis.del(passwordOtpKey(sid));
          if ((await redis.get(cooldown)) === owner) await redis.del(cooldown);
          await recordAuthEvent("password_code_mail_failed", req, { email, status: "failed" });
          req.log.warn(
            {
              emailHash: emailHash(email),
              mailerError: mailResult.error,
              mailerDetail: mailResult.detail,
              requestedProvider,
            },
            "password send-code mailer failed",
          );
          return res.status(502).json({ error: "Не удалось отправить код" });
        }

        const sendNumber = await countMailSend(req, sendsKey);
        req.log.info(
          {
            emailHash: emailHash(email),
            messageId: mailResult.messageId,
            requestedProvider,
            provider: mailResult.provider,
            failover: mailResult.failover,
          },
          "password send-code dispatched",
        );
        await recordAuthEvent("password_code_sent", req, {
          email,
          status: "ok",
          provider: mailResult.provider,
          failover: mailResult.failover,
        });
        return res.json(sendCodeOk(sendNumber));
      } catch (err) {
        return serverError(res, req, err);
      }
    },
  );

  router.post(
    "/api/auth/password/change",
    requireSession,
    verifyIpLimiter,
    passwordChangeAttemptLimiter,
    async (req, res) => {
      try {
        const parsed = passwordChangeSchema.safeParse(req.body);
        if (!parsed.success) {
          return clientError(res, 400, parsed.error.issues[0]?.message || "Некорректный пароль или код");
        }
        const hashed = await hashPassword(parsed.data.newPassword);
        const outcome = await changePassword(req.session.email, req.session.sid, parsed.data.code, hashed);
        if (outcome === "ok") {
          await recordAuthEvent("password_changed", req, {
            email: req.session.email,
            userUuid: req.session.userUuid,
            status: "ok",
          });
          return res.json({ ok: true, hasPassword: true });
        }
        if (outcome === "bad_code") return clientError(res, 400, "Неверный код");
        if (outcome === "too_many_tries") return clientError(res, 410, "Слишком много попыток. Запросите новый код.");
        if (outcome === "missing") return clientError(res, 400, "Код истёк или не найден. Запросите новый код");
        return clientError(res, 409, "Данные изменились. Запросите новый код");
      } catch (err) {
        return serverError(res, req, err);
      }
    },
  );

  router.post("/api/auth/logout", requireSession, async (req, res) => {
    await deleteSession(req.session.sid);
    clearSessionCookies(res);
    return res.json({ ok: true });
  });

  return router;
}
