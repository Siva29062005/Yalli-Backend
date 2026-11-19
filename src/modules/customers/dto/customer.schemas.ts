import { z } from 'zod';
import { phoneSchema } from '../../identity/dto/auth.schemas.js';

/** States and union territories of India (address validation for the current single-country store). */
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

export const updateProfileSchema = z
  .object({
    firstName: text(60).optional(),
    lastName: text(60).optional(),
    newsletterSubscribed: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const addressFields = {
  label: optionalText(40),
  fullName: text(120),
  phone: phoneSchema,
  line1: text(200),
  line2: optionalText(200),
  landmark: optionalText(120),
  city: text(80),
  state: z.enum(INDIAN_STATES),
  postalCode: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit PIN code'),
  isDefault: z.boolean().optional(),
};
export const createAddressSchema = z.object(addressFields).strict();
/** On update, optional text fields may be cleared: `null` or `''` stores NULL; omitting the field keeps it. */
const clearableText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(max).nullable().optional(),
  );
export const updateAddressSchema = z
  .object({
    label: clearableText(40),
    fullName: addressFields.fullName.optional(),
    phone: addressFields.phone.optional(),
    line1: addressFields.line1.optional(),
    line2: clearableText(200),
    landmark: clearableText(120),
    city: addressFields.city.optional(),
    state: addressFields.state.optional(),
    postalCode: addressFields.postalCode.optional(),
    isDefault: addressFields.isDefault,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type CreateAddressDto = z.infer<typeof createAddressSchema>;
export type UpdateAddressDto = z.infer<typeof updateAddressSchema>;

export const reauthSchema = z
  .object({
    password: z.string().min(1).max(128),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
export const uuidParam = z.uuid();
