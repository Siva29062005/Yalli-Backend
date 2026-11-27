import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { AccessModule } from '../access/access.module.js';
import { AuthCookies } from './auth-cookies.service.js';
import { AuthController } from './auth.controller.js';
import {
  NoopCaptchaVerifier,
  TurnstileCaptchaVerifier,
} from './adapters/captcha.adapters.js';
import {
  DisabledBreachedPasswordChecker,
  HibpBreachedPasswordChecker,
} from './adapters/breached-password.adapters.js';
import { ChannelNotificationAdapter } from './adapters/channel-notification.adapter.js';
import { ConsoleNotificationAdapter } from './adapters/console-notification.adapter.js';
import { Msg91SmsTransport } from './adapters/msg91-sms.transport.js';
import { SesEmailTransport } from './adapters/ses-email.transport.js';
import { PasswordService } from './crypto/password.service.js';
import { SecretBox } from './crypto/secret-box.service.js';
import { MfaKeyRotationService } from './services/mfa-key-rotation.service.js';
import { CsrfGuard } from './guards/csrf.guard.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PermissionsGuard } from './guards/permissions.guard.js';
import { AccessTokenService } from './jwt/access-token.service.js';
import { JwksController } from './jwks.controller.js';
import { MeController } from './me.controller.js';
import { MfaController } from './mfa.controller.js';
import {
  BreachedPasswordChecker,
  CaptchaVerifier,
  NotificationPort,
} from './ports/ports.js';
import { AccountSecurityService } from './services/account-security.service.js';
import { AuthService } from './services/auth.service.js';
import { MfaService } from './services/mfa.service.js';
import { RegistrationService } from './services/registration.service.js';
import { SessionStateService } from './services/session-state.service.js';
import { VerificationService } from './services/verification.service.js';
import { SessionsController } from './sessions.controller.js';

@Module({
  imports: [AccessModule],
  controllers: [
    AuthController,
    MfaController,
    SessionsController,
    MeController,
    JwksController,
  ],
  providers: [
    AccessTokenService,
    PasswordService,
    SecretBox,
    MfaKeyRotationService,
    AuthCookies,
    VerificationService,
    RegistrationService,
    AuthService,
    MfaService,
    AccountSecurityService,
    SessionStateService,
    CsrfGuard,
    JwtAuthGuard,
    PermissionsGuard,
    {
      provide: CaptchaVerifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('CAPTCHA_PROVIDER', { infer: true }) === 'turnstile'
          ? new TurnstileCaptchaVerifier(config)
          : new NoopCaptchaVerifier(),
    },
    {
      provide: BreachedPasswordChecker,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('HIBP_ENABLED', { infer: true })
          ? new HibpBreachedPasswordChecker()
          : new DisabledBreachedPasswordChecker(),
    },
    {
      provide: NotificationPort,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('NOTIFICATIONS_DRIVER', { infer: true }) === 'ses_msg91'
          ? new ChannelNotificationAdapter(
              config,
              new SesEmailTransport(config),
              new Msg91SmsTransport(config),
            )
          : new ConsoleNotificationAdapter(config),
    },
  ],
  exports: [
    MfaKeyRotationService,
    AccessTokenService,
    SessionStateService,
    JwtAuthGuard,
    PermissionsGuard,
    PasswordService,
    MfaService,
    NotificationPort,
    CaptchaVerifier,
  ],
})
export class IdentityModule {}
