import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditService } from './audit.service';
import { CryptoService } from './crypto.service';
import { AllExceptionsFilter } from './exception.filter';
import { MailService } from './mail.service';
import { DbService, PrismaService } from './prisma.service';
import { RateLimitService } from './rate-limit.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [PrismaService, DbService, RedisService, CryptoService, RateLimitService, MailService, AuditService, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
  exports: [PrismaService, DbService, RedisService, CryptoService, RateLimitService, MailService, AuditService],
})
export class CommonModule {}
