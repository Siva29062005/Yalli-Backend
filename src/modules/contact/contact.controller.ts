import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Public } from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseMessage } from '../../common/decorators/response.decorators.js';
import { requestContext } from '../audit/audit.service.js';
import { ContactService } from './contact.service.js';

const HOUR = 3600;

export const contactSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.email().max(254),
    orderNumber: z
      .string()
      .trim()
      .regex(/^[A-Z0-9-]{4,20}$/i)
      .optional(),
    topic: z.enum([
      'ORDER',
      'RETURN',
      'PAYMENT',
      'ACCOUNT',
      'PRODUCT',
      'OTHER',
    ]),
    message: z.string().trim().min(10).max(2000),
    captchaToken: z.string().max(2048).optional(),
    website: z.string().max(200).optional(),
  })
  .strict();

@ApiTags('contact')
@Controller('contact')
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Public()
  @Post()
  @HttpCode(202)
  @ResponseMessage('Thanks, we have your message and will reply by email')
  // Per IP only here (before validation): a per-address limit at this point would let anyone exhaust someone else's
  // address with junk. The per-address cap is in ContactService, after the captcha. 10/hour leaves room for shared
  // mobile-network IPs.
  @RateLimit({ name: 'contact-ip', limit: 10, windowSeconds: HOUR, key: 'ip' })
  async submit(
    @Body({ schema: contactSchema }) dto: z.infer<typeof contactSchema>,
    @Req() req: Request,
  ): Promise<null> {
    await this.contact.submit(dto, requestContext(req).ip);
    return null;
  }
}
