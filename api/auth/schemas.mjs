import { z } from "zod";
import { EMAIL_RE, REF_UUID_RE } from "../config.mjs";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((v) => EMAIL_RE.test(v), { message: "Invalid email" });

export const sendCodeSchema = z.object({
  email: emailSchema,
  ref_uuid: z
    .string()
    .trim()
    .regex(REF_UUID_RE, "Invalid ref_uuid")
    .optional(),
  fingerprint: z.string().trim().max(256).optional(),
});

export const passwordSchema = z
  .string()
  .min(6, "Пароль должен содержать не менее 6 символов")
  .max(128, "Пароль должен содержать не более 128 символов")
  .refine((value) => /\p{L}/u.test(value) && /\d/.test(value), {
    message: "Пароль должен содержать хотя бы одну букву и одну цифру",
  });

export const methodSchema = z.object({ email: emailSchema });

export const passwordLoginSchema = z.object({
  email: emailSchema,
  password: z.string().max(128),
});

export const verifySchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{5}$/, "Code must be 5 digits"),
  ref_uuid: z
    .string()
    .trim()
    .regex(REF_UUID_RE, "Invalid ref_uuid")
    .optional(),
  fingerprint: z.string().trim().max(256).optional(),
  newPassword: passwordSchema.optional(),
});

export const passwordChangeSchema = z.object({
  code: z.string().trim().regex(/^\d{5}$/, "Code must be 5 digits"),
  newPassword: passwordSchema,
});

export const adminSetPasswordSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
