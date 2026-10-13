import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { z } from 'zod';
import { AnyRole, CurrentSession, Public, StepUp, Stages } from '../common/decorators';
import { SessionData } from '../common/types';
import { emailField, ZodPipe } from '../common/zod.pipe';
import { AuthService } from './auth.service';
import { NoStepUp } from './guards';
import { MfaService } from './mfa.service';
import { PrismaService } from '../common/prisma.service';

const loginSchema = z.object({ email: emailField, password: z.string().min(1).max(256) }).strict();
const activateSchema = z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(256) }).strict();
const verifySchema = z.object({ method: z.enum(['totp', 'email', 'recovery']), code: z.string().min(1).max(40), remember_device: z.boolean().optional() }).strict();
const codeSchema = z.object({ code: z.string().min(6).max(10) }).strict();
const passwordSchema = z.object({ current_password: z.string().min(1).max(256), new_password: z.string().min(1).max(256) }).strict();
const passkeyAuthSchema = z.object({ response: z.record(z.unknown()) }).strict();
const passkeyRegSchema = z.object({ response: z.record(z.unknown()), label: z.string().trim().max(60).optional() }).strict();

/**
 * Authentication endpoints. Login is two steps (password, then second factor) and the browser holds nothing but an
 * opaque HttpOnly cookie. `stage` tells the SPA where the user is: mfa_pending / enrol_pending / full.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return (await this.auth.login(body.email, body.password, { req, res })).payload;
  }

  @Public()
  @Post('activate')
  @HttpCode(200)
  activate(@Body(new ZodPipe(activateSchema)) body: z.infer<typeof activateSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.activate(body.token, body.password, { req, res });
  }

  @AnyRole()
  @Stages('mfa_pending', 'enrol_pending', 'full')
  @Get('me')
  me(@CurrentSession() s: SessionData) {
    return this.auth.payload(s);
  }

  // ---- second factor: login (mfa_pending) and step-up (full) share the same endpoints ----

  @AnyRole()
  @Stages('mfa_pending', 'full')
  @NoStepUp()
  @Post('mfa/email/send')
  @HttpCode(204)
  async sendEmail(@CurrentSession() s: SessionData) {
    await this.mfa.sendEmailOtp({ id: s.user_id, email: s.email, role: s.role }, s.stage === 'full' ? 'step_up' : 'login');
  }

  @AnyRole()
  @Stages('mfa_pending', 'full')
  @NoStepUp()
  @Post('mfa/verify')
  @HttpCode(200)
  verify(@Body(new ZodPipe(verifySchema)) body: z.infer<typeof verifySchema>, @CurrentSession() s: SessionData, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.verifySecondFactor(s, body, { req, res });
  }

  @AnyRole()
  @Stages('mfa_pending', 'full')
  @NoStepUp()
  @Post('mfa/passkey/options')
  @HttpCode(200)
  passkeyOptions(@CurrentSession() s: SessionData) {
    return this.auth.startPasskeyAuth(s);
  }

  @AnyRole()
  @Stages('mfa_pending', 'full')
  @NoStepUp()
  @Post('mfa/passkey/verify')
  @HttpCode(200)
  passkeyVerify(@Body(new ZodPipe(passkeyAuthSchema)) body: z.infer<typeof passkeyAuthSchema>, @CurrentSession() s: SessionData, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.verifyPasskey(s, body.response as never, { req, res });
  }

  // ---- enrolment (before first data access) and adding factors later (needs a recent step-up) ----

  @AnyRole()
  @Stages('enrol_pending', 'full')
  @StepUp()
  @Post('enrol/totp/start')
  @HttpCode(200)
  totpStart(@CurrentSession() s: SessionData) {
    return this.auth.startTotpEnrol(s);
  }

  @AnyRole()
  @Stages('enrol_pending', 'full')
  @StepUp()
  @Post('enrol/totp/confirm')
  @HttpCode(200)
  totpConfirm(@Body(new ZodPipe(codeSchema)) body: z.infer<typeof codeSchema>, @CurrentSession() s: SessionData, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.confirmTotpEnrol(s, body.code, { req, res });
  }

  @AnyRole()
  @Stages('enrol_pending', 'full')
  @StepUp()
  @Post('enrol/passkey/options')
  @HttpCode(200)
  passkeyRegOptions(@CurrentSession() s: SessionData) {
    return this.auth.startPasskeyEnrol(s);
  }

  @AnyRole()
  @Stages('enrol_pending', 'full')
  @StepUp()
  @Post('enrol/passkey/verify')
  @HttpCode(200)
  passkeyRegVerify(@Body(new ZodPipe(passkeyRegSchema)) body: z.infer<typeof passkeyRegSchema>, @CurrentSession() s: SessionData, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.confirmPasskeyEnrol(s, body.response as never, body.label, { req, res });
  }

  @AnyRole()
  @Get('factors')
  async factors(@CurrentSession() s: SessionData) {
    const f = await this.mfa.confirmedFactors(s.user_id);
    const codes = await this.prisma.recovery_code.count({ where: { user_id: s.user_id, used_at: null } });
    return { factors: f.map((x) => ({ id: x.id, type: x.type, label: x.label, created_at: x.created_at })), recovery_codes_left: codes };
  }

  @AnyRole()
  @StepUp()
  @Post('recovery-codes/regenerate')
  @HttpCode(200)
  async regenerate(@CurrentSession() s: SessionData) {
    return { recovery_codes: await this.mfa.regenerateRecoveryCodes(s.user_id) };
  }

  @AnyRole()
  @StepUp()
  @Post('password/change')
  @HttpCode(200)
  changePassword(@Body(new ZodPipe(passwordSchema)) body: z.infer<typeof passwordSchema>, @CurrentSession() s: SessionData, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.changePassword(s, body.current_password, body.new_password, { req, res });
  }

  @AnyRole()
  @Stages('mfa_pending', 'enrol_pending', 'full')
  @NoStepUp()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentSession() s: SessionData, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(s, { req, res });
  }

  @AnyRole()
  @Stages('full')
  @NoStepUp()
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentSession() s: SessionData, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(s, { req, res });
  }
}
