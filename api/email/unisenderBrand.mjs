// Brand tag for mail sent through Unisender Go (the backup SMTP). One Unisender
// account serves several sites and webhook events carry no sender, so each site
// tags its mail with X-UNISENDER-GO global_metadata.brand and its webhook keeps
// only events with its own brand. A code constant on purpose, not env.
// No imports here: the mailer loads this without pulling in Redis.
export const UNISENDER_BRAND = "v220";
export const UNISENDER_HEADER_NAME = "X-UNISENDER-GO";
export const UNISENDER_HEADER_VALUE = JSON.stringify({ global_metadata: { brand: UNISENDER_BRAND } });
