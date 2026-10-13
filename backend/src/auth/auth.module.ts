import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { WebAuthnService } from './webauthn.service';
import { SessionService } from './session.service';
import { CsrfGuard, RolesGuard, SessionAuthGuard, SessionStrategy, StepUpGuard } from './guards';

@Global()
@Module({
  imports: [PassportModule.register({ session: false })],
  controllers: [AuthController],
  providers: [
    SessionService,
    MfaService,
    WebAuthnService,
    AuthService,
    SessionStrategy,
    // Order matters: authenticate -> CSRF/origin -> role + stage (deny by default) -> step-up.
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: StepUpGuard },
  ],
  exports: [SessionService, MfaService, AuthService],
})
export class AuthModule {}
