import { BadRequestException, Injectable } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from '@simplewebauthn/server';
import { PrismaService } from '../common/prisma.service';
import { env } from '../config/env';

/**
 * Passkeys / FIDO2 hardware keys (@simplewebauthn/server). The challenge lives in the server-side session scratch
 * area, never in the browser, and is single-use: it is cleared as soon as a verification is attempted.
 */
@Injectable()
export class WebAuthnService {
  constructor(private readonly prisma: PrismaService) {}

  private get rpID() {
    return env.WEBAUTHN_RP_ID;
  }
  private get origin() {
    return env.WEB_ORIGIN;
  }

  async registrationOptions(user: { id: string; email: string; name: string }) {
    const existing = await this.prisma.mfa_factor.findMany({ where: { user_id: user.id, type: 'passkey' } });
    const options = await generateRegistrationOptions({
      rpName: env.WEBAUTHN_RP_NAME,
      rpID: this.rpID,
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.filter((f) => f.credential_id).map((f) => ({ id: f.credential_id!, transports: parseTransports(f.transports) })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    return { options, challenge: options.challenge };
  }

  async verifyRegistration(userId: string, response: RegistrationResponseJSON, expectedChallenge: string, label?: string) {
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: this.origin, expectedRPID: this.rpID, requireUserVerification: false });
    } catch (e) {
      throw new BadRequestException({ message: `Passkey registration failed: ${(e as Error).message}`, code: 'WEBAUTHN_FAILED' });
    }
    if (!verification.verified || !verification.registrationInfo) throw new BadRequestException({ message: 'Passkey could not be verified', code: 'WEBAUTHN_FAILED' });
    const { credential } = verification.registrationInfo;
    return this.prisma.mfa_factor.create({
      data: {
        user_id: userId,
        type: 'passkey',
        credential_id: credential.id,
        public_key: Buffer.from(credential.publicKey).toString('base64url'),
        counter: BigInt(credential.counter),
        transports: (credential.transports ?? response.response.transports ?? []).join(','),
        label: label ?? 'Passkey',
        confirmed_at: new Date(),
      },
    });
  }

  async authenticationOptions(userId: string) {
    const creds = await this.prisma.mfa_factor.findMany({ where: { user_id: userId, type: 'passkey', confirmed_at: { not: null } } });
    if (!creds.length) throw new BadRequestException({ message: 'No passkey is registered for this account', code: 'NO_PASSKEY' });
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: 'preferred',
      allowCredentials: creds.map((c) => ({ id: c.credential_id!, transports: parseTransports(c.transports) })),
    });
    return { options, challenge: options.challenge };
  }

  /** Returns true when the assertion is valid. Updates the signature counter (clone detection). */
  async verifyAuthentication(userId: string, response: AuthenticationResponseJSON, expectedChallenge: string): Promise<boolean> {
    const cred = await this.prisma.mfa_factor.findFirst({ where: { user_id: userId, type: 'passkey', credential_id: response.id, confirmed_at: { not: null } } });
    if (!cred?.public_key) return false;
    try {
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: false,
        credential: {
          id: cred.credential_id!,
          publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
          counter: Number(cred.counter),
          transports: parseTransports(cred.transports),
        },
      });
      if (!v.verified) return false;
      await this.prisma.mfa_factor.update({ where: { id: cred.id }, data: { counter: BigInt(v.authenticationInfo.newCounter) } });
      return true;
    } catch {
      return false;
    }
  }
}

function parseTransports(t: string | null): AuthenticatorTransportFuture[] | undefined {
  const parts = (t ?? '').split(',').filter(Boolean);
  return parts.length ? (parts as AuthenticatorTransportFuture[]) : undefined;
}
