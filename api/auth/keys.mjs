import { createHash } from "node:crypto";

const PREFIX = "v220:";

export const sessionKey = (sid) => `${PREFIX}sess:${sid}`;
export const otpKey = (email) => `${PREFIX}otp:${email}`;
export const otpCooldownKey = (email) => `${PREFIX}otp:cooldown:${email}`;
// Password credentials are keyed by an email hash so the address is not stored in the key name.
export const credentialKey = (email) => `${PREFIX}cred:${createHash("sha256").update(email).digest("hex")}`;
export const passwordOtpKey = (sid) => `${PREFIX}password:otp:${sid}`;
export const passwordCooldownKey = (sid) => `${PREFIX}password:otp:cooldown:${sid}`;
// Successful OTP email sends in the provider window (a resend goes through the backup SMTP).
// Kept outside the `otp:` namespace so admin OTP scans do not count them as codes;
// the login counter is keyed by an email hash, like credentialKey.
export const otpMailSendsKey = (email) =>
  `${PREFIX}mail:otp_sends:${createHash("sha256").update(email).digest("hex")}`;
export const passwordMailSendsKey = (sid) => `${PREFIX}mail:password_sends:${sid}`;
// Last Unisender bounce for an address (JSON {category, deliveryStatus, at}), set by the webhook.
export const mailBounceKey = (email) => `${PREFIX}mailbounce:${email}`;

export const refEventsListKey = () => `${PREFIX}ref:events`;
export const refEventsReferrerIndexKey = (refUuid) => `${PREFIX}ref:events:by_referrer:${refUuid}`;
export const refEventsIpIndexKey = (ipHash) => `${PREFIX}ref:events:by_ip:${ipHash}`;
export const refEventsUaIndexKey = (uaHash) => `${PREFIX}ref:events:by_ua:${uaHash}`;
export const refEventsFingerprintIndexKey = (fingerprintHash) => `${PREFIX}ref:events:by_fingerprint:${fingerprintHash}`;
export const refStatsReferrerKey = (refUuid) => `${PREFIX}ref:stats:referrer:${refUuid}`;
export const refClickSeenKey = (refUuid, ipHash) => `${PREFIX}ref:clickseen:${refUuid}:${ipHash}`;
export const refUserStatusKey = (refUuid) => `${PREFIX}ref:user_status:${refUuid}`;
export const refExchangeRequestKey = (id) => `${PREFIX}ref:exchange_request:${id}`;
export const refExchangeRequestsPendingKey = () => `${PREFIX}ref:exchange_requests:pending`;
export const refExchangeRequestsUserKey = (refUuid) => `${PREFIX}ref:exchange_requests:by_referrer:${refUuid}`;

export const SCAN_PATTERNS = {
  otp: `${PREFIX}otp:*`,
  otpCooldown: `${PREFIX}otp:cooldown:*`,
  session: `${PREFIX}sess:*`,
  rlSendCodeIp: `${PREFIX}rl:sendcode:ip:*`,
  rlSendCodeEmail: `${PREFIX}rl:sendcode:email:*`,
  rlVerifyIp: `${PREFIX}rl:verify:ip:*`,
  rlCheckoutSid: `${PREFIX}rl:checkout:sid:*`,
  rlTalkmeIp: `${PREFIX}rl:talkme:ip:*`,
  rlTalkmeSid: `${PREFIX}rl:talkme:sid:*`,
  rlChatUploadSid: `${PREFIX}rl:chatupload:sid:*`,
  refEvents: `${PREFIX}ref:events`,
  refEventsByReferrer: `${PREFIX}ref:events:by_referrer:*`,
  refEventsByIp: `${PREFIX}ref:events:by_ip:*`,
  refEventsByUa: `${PREFIX}ref:events:by_ua:*`,
  refEventsByFingerprint: `${PREFIX}ref:events:by_fingerprint:*`,
  refStatsReferrer: `${PREFIX}ref:stats:referrer:*`,
  refClickSeen: `${PREFIX}ref:clickseen:*`,
  refUserStatus: `${PREFIX}ref:user_status:*`,
  refExchangeRequests: `${PREFIX}ref:exchange_request:*`,
  refExchangeRequestsPending: `${PREFIX}ref:exchange_requests:pending`,
  refExchangeRequestsByReferrer: `${PREFIX}ref:exchange_requests:by_referrer:*`,
  rlRefClickIp: `${PREFIX}rl:refclick:ip:*`,
};

export const RL_PREFIXES = {
  sendCodeIp: `${PREFIX}rl:sendcode:ip:`,
  sendCodeEmail: `${PREFIX}rl:sendcode:email:`,
  verifyIp: `${PREFIX}rl:verify:ip:`,
  checkoutSession: `${PREFIX}rl:checkout:sid:`,
  talkmeIp: `${PREFIX}rl:talkme:ip:`,
  talkmeSession: `${PREFIX}rl:talkme:sid:`,
  chatUploadSession: `${PREFIX}rl:chatupload:sid:`,
  refClickIp: `${PREFIX}rl:refclick:ip:`,
};

export const KEY_PREFIXES = {
  otp: `${PREFIX}otp:`,
  otpCooldown: `${PREFIX}otp:cooldown:`,
};
