export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 128;

/** Совпадает с passwordSchema в api/auth/schemas.mjs. */
export const isValidNewPassword = (password: string) =>
  password.length >= MIN_PASSWORD_LENGTH &&
  password.length <= MAX_PASSWORD_LENGTH &&
  /\p{L}/u.test(password) &&
  /\d/.test(password);

export const PASSWORD_REQUIREMENTS = "Пароль должен содержать 6–128 символов, хотя бы одну букву и одну цифру";

export const SUPPORT_EMAIL = "support@220v.shop";
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;
