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

const emailKey = (req: Request) => {
  const e = (req.body as { email?: unknown } | undefined)?.email;
  return typeof e === 'string' ? e.trim().toLowerCase() : undefined;
};

@ApiTags('contact')
@Controller('contact')
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Public()
  @Post()
  @HttpCode(202)
  @ResponseMessage('Thanks, we have your message and will reply by email')
  @RateLimit(
    { name: 'contact-ip', limit: 5, windowSeconds: HOUR, key: 'ip' },
    { name: 'contact-email', limit: 3, windowSeconds: HOUR, key: emailKey },
  )
  async submit(
    @Body({ schema: contactSchema }) dto: z.infer<typeof contactSchema>,
    @Req() req: Request,
  ): Promise<null> {
    await this.contact.submit(dto, requestContext(req).ip);
    return null;
  }
}
