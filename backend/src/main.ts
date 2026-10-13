import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { env } from './config/env';

/** Security middleware shared by the real server and the e2e tests, so the tests exercise the same stack. */
export function configureApp(app: NestExpressApplication) {
  // Behind Nginx / the WAF the client IP comes from X-Forwarded-For; trust only when told to.
  app.set('trust proxy', env.TRUST_PROXY ? 1 : false);
  app.disable('x-powered-by');
  app.use(
    helmet({
      // This is a JSON API: nothing it returns should ever be rendered as a page or framed.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());
  app.use(json({ limit: '200kb' }));
  app.use(urlencoded({ extended: false, limit: '50kb' }));
  app.setGlobalPrefix('api');
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'X-CSRF-Token'], exposedHeaders: ['Content-Disposition', 'X-Export-Id', 'X-Export-SHA256', 'X-Export-Rows'], maxAge: 600 });
  // API responses carry personal data: never cache them.
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`NFSU Placement Portal API listening on :${env.PORT} (${env.NODE_ENV})`);
}

if (require.main === module) void bootstrap();
