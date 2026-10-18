import { Inject, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import pg from 'pg';
import { bearerTokenAuth, MemoryScimStore, MemoryTokenStore, type ScimStore, ScimTokens } from 'scimkit';
import { ScimModule } from 'scimkit/nestjs';
import { PostgresScimStore, PostgresTokenStore } from 'scimkit/postgres';
import { Public, SessionGuard } from './auth.js';
import { SessionsService } from './sessions.service.js';

export const SCIM_STORE = Symbol('SCIM_STORE');
const DATABASE = Symbol('DATABASE');

/**
 * Storage for SCIM: PostgreSQL when DATABASE_URL is set, memory otherwise.
 * The tables are created (or upgraded) when the application starts.
 */
@Module({
  providers: [
    SessionsService,
    {
      provide: DATABASE,
      useFactory: () =>
        process.env['DATABASE_URL'] === undefined
          ? undefined
          : new pg.Pool({ connectionString: process.env['DATABASE_URL'] }),
    },
    {
      provide: SCIM_STORE,
      inject: [DATABASE],
      useFactory: (pool: pg.Pool | undefined): ScimStore =>
        pool === undefined ? new MemoryScimStore() : new PostgresScimStore({ pool }),
    },
    {
      provide: ScimTokens,
      inject: [DATABASE],
      useFactory: (pool: pg.Pool | undefined) =>
        new ScimTokens(pool === undefined ? new MemoryTokenStore() : new PostgresTokenStore({ pool })),
    },
  ],
  exports: [SessionsService, SCIM_STORE, ScimTokens],
})
export class IdentityModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(DATABASE) private readonly pool: pg.Pool | undefined,
    @Inject(SCIM_STORE) private readonly store: ScimStore,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.store instanceof PostgresScimStore) await this.store.migrate();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

@Module({
  imports: [
    IdentityModule,
    ScimModule.forRootAsync({
      imports: [IdentityModule],
      inject: [SCIM_STORE, ScimTokens, SessionsService],
      useFactory: (store: ScimStore, tokens: ScimTokens, sessions: SessionsService) => ({
        store,
        // Each customer organization gets its own token: `scimkit token create --tenant <org>`.
        authenticate: bearerTokenAuth(tokens),
        hooks: {
          onEvent: (event) => {
            if (event.type === 'user.deactivated' || event.type === 'resource.deleted')
              sessions.revokeAll(event.id);
          },
        },
      }),
      path: 'scim/v2',
      decorators: [Public()],
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: SessionGuard }],
})
export class AppModule {}
