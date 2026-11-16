import type { INestApplication, Type } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { TEST_ENV } from './test-env';

/**
 * Boots the real AppModule with the same middleware, pipes and interceptors as main.ts.
 * `configure` can override providers, e.g. to swap the chat model for a fake.
 */
export async function createTestApp(
  controllers: Type[] = [],
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (
    builder,
  ) => builder,
): Promise<INestApplication<App>> {
  const moduleFixture = await configure(
    Test.createTestingModule({ imports: [AppModule], controllers }),
  ).compile();
  const app = configureApp(
    moduleFixture.createNestApplication<INestApplication<App>>({
      logger: false,
    }),
  );
  await app.init();
  return app;
}

/**
 * Acts as a user with a real access token, signed like the auth module does
 * (HS256, 15 minutes). The guard still loads the user from the database, so
 * role and status come from the fixtures, not from this token.
 */
export const as = (userId: number) => ({
  Authorization: `Bearer ${signAccessToken(String(userId))}`,
});

function signAccessToken(sub: string): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub, role: 'member', iat: now, exp: now + 900 })}`;
  const signature = createHmac('sha256', TEST_ENV.JWT_ACCESS_SECRET)
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}
