import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';

/** All request schemas are `.strict()`: unknown fields (e.g. `role`, `status`) are rejected, not ignored. */

export const emailSchema = z.string().trim().min(3).max(254).pipe(z.email());

/** Parses to canonical E.164. Defaults to India for national-format numbers (the store's market). */
export const phoneSchema = z
  .string()
  .trim()
  .min(6)
  .max(20)
  .transform((value, ctx) => {
    const parsed = parsePhoneNumberFromString(value, 'IN');
    if (!parsed?.isValid()) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' });
      return z.NEVER;
    }
    return parsed.number; // E.164
  });

const name = z.string().trim().min(1).max(60);
const otpCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
/** Login/verify inputs are length-capped only; the strength policy is enforced where passwords are SET. */
const anyPassword = z.string().min(1).max(128);
const opaqueToken = z.string().min(20).max(200);

export const registerSchema = z
  .object({
    firstName: name,
    lastName: name,
    email: emailSchema,
    phone: phoneSchema,
    password: anyPassword,
    newsletter: z.boolean().default(false),
    acceptPrivacyPolicy: z.literal(true, {
      error: 'You must accept the privacy policy',
    }),
    captchaToken: z.string().max(2048).optional(),
  })
  .strict();
export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = z
  .object({
    email: emailSchema,
    password: anyPassword,
    deviceLabel: z.string().trim().max(100).optional(),
    /** "Keep me signed in". Absent or false: the refresh cookie lasts until the browser closes. Ignored for staff. */
    remember: z.boolean().optional(),
  })
  .strict();
export type LoginDto = z.infer<typeof loginSchema>;

export const refreshSchema = z
  .object({ refreshToken: opaqueToken.optional() })
  .strict();
export const verifyEmailSchema = z.object({ token: opaqueToken }).strict();
export const emailOnlySchema = z
  .object({ email: emailSchema, captchaToken: z.string().max(2048).optional() })
  .strict();
export const resetPasswordSchema = z
  .object({ token: opaqueToken, newPassword: anyPassword })
  .strict();
export const changePasswordSchema = z
  .object({ currentPassword: anyPassword, newPassword: anyPassword })
  .strict();
export const phoneVerifySchema = z.object({ code: otpCode }).strict();

const oneFactor = (v: {
  code?: string | undefined;
  recoveryCode?: string | undefined;
}) => (v.code === undefined) !== (v.recoveryCode === undefined);
const oneFactorMsg = { message: 'Provide either code or recoveryCode' };

export const mfaEnrollSchema = z.object({ password: anyPassword }).strict();
export const mfaConfirmSchema = z.object({ code: otpCode }).strict();
export const mfaCodeSchema = z.object({ code: otpCode }).strict();
export const mfaVerifySchema = z
  .object({
    mfaToken: opaqueToken,
    code: otpCode.optional(),
    recoveryCode: z.string().min(8).max(32).optional(),
    remember: z.boolean().optional(),
  })
  .strict()
  .refine(oneFactor, oneFactorMsg);
export const mfaDisableSchema = z
  .object({
    password: anyPassword,
    code: otpCode.optional(),
    recoveryCode: z.string().min(8).max(32).optional(),
  })
  .strict()
  .refine(oneFactor, oneFactorMsg);

export const sessionIdParamSchema = z.uuid();
