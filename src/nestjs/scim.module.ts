import {
  All,
  Controller,
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnModuleInit,
  Param,
  type Provider,
  Req,
  Res,
  type Type,
} from '@nestjs/common';
import { type AbstractHttpAdapter, HttpAdapterHost } from '@nestjs/core';
import { isScimError, ScimError } from '../errors.js';
import { ScimServer, type ScimServerOptions } from '../protocol/server.js';
import type { ScimLogger } from '../protocol/types.js';

/** Options of the NestJS integration that are not ScimServer options. */
export interface ScimModuleConfig {
  /** Route of the SCIM root, below any global prefix. Default "scim/v2". */
  path?: string;
  /**
   * Class decorators for the SCIM controller, for example to exempt it from a
   * global authentication guard (`[Public()]`) or rate limiter (`[SkipThrottle()]`).
   * SCIM requests authenticate with their own bearer tokens.
   */
  decorators?: readonly ClassDecorator[];
  /** Largest request body scimkit reads itself (application/scim+json). Default 5 MiB. */
  bodyLimit?: number;
  /** Derive the base URL from X-Forwarded-Proto and X-Forwarded-Host. Default false. */
  trustProxy?: boolean;
  /** Register the module globally. Default false. */
  global?: boolean;
}

export type ScimModuleOptions = ScimServerOptions & ScimModuleConfig;

export interface ScimOptionsFactory {
  createScimOptions(): ScimServerOptions | Promise<ScimServerOptions>;
}

export interface ScimModuleAsyncOptions extends ScimModuleConfig {
  imports?: DynamicModule['imports'];
  inject?: unknown[];
  useFactory?: (...args: never[]) => ScimServerOptions | Promise<ScimServerOptions>;
  useClass?: Type<ScimOptionsFactory>;
  useExisting?: Type<ScimOptionsFactory>;
}

/** Injection token of the ScimServer options. */
export const SCIM_OPTIONS = Symbol.for('scimkit.nestjs.options');
const SCIM_CONFIG = Symbol.for('scimkit.nestjs.config');

interface ResolvedConfig {
  readonly bodyLimit: number;
  readonly trustProxy: boolean;
}

interface NodeLikeRequest {
  method: string;
  url: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  protocol?: string;
  readable?: boolean;
  readableEnded?: boolean;
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | string>;
  raw?: { readable?: boolean };
}

function nestLogger(): ScimLogger {
  const logger = new Logger('ScimModule');
  const format = (message: string, fields?: Readonly<Record<string, unknown>>) =>
    fields === undefined ? message : `${message} ${JSON.stringify(fields)}`;
  return {
    debug: (message, fields) => {
      logger.debug(format(message, fields));
    },
    info: (message, fields) => {
      logger.log(format(message, fields));
    },
    warn: (message, fields) => {
      logger.warn(format(message, fields));
    },
    error: (message, fields) => {
      const { error, ...rest } = fields ?? {};
      logger.error(
        format(message, Object.keys(rest).length > 0 ? rest : undefined),
        typeof error === 'string' ? error : undefined,
      );
    },
  };
}

function createServer(options: ScimServerOptions): ScimServer {
  return new ScimServer({ ...options, logger: options.logger ?? nestLogger() });
}

/** Registers a parser for application/scim+json when the application runs on Fastify. */
@Injectable()
class ScimBodyParsers implements OnModuleInit {
  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(SCIM_CONFIG) private readonly config: ResolvedConfig,
  ) {}

  onModuleInit(): void {
    // Applications without an HTTP server (microservices) have no adapter.
    const adapter = this.adapterHost.httpAdapter as AbstractHttpAdapter | undefined;
    const instance = adapter?.getInstance<
      | {
          addContentTypeParser?: (
            type: string,
            options: { parseAs: 'string'; bodyLimit: number },
            parser: (
              request: unknown,
              body: string,
              done: (error: Error | null, body?: unknown) => void,
            ) => void,
          ) => void;
          hasContentTypeParser?: (type: string) => boolean;
        }
      | undefined
    >();
    if (typeof instance?.addContentTypeParser !== 'function') return;
    if (instance.hasContentTypeParser?.('application/scim+json') === true) return;
    // The raw text is handed to scimkit, which answers malformed JSON with a SCIM error.
    instance.addContentTypeParser(
      'application/scim+json',
      { parseAs: 'string', bodyLimit: this.config.bodyLimit },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }
}

function createController(path: string, decorators: readonly ClassDecorator[]): Type {
  @Controller(path)
  class ScimController {
    constructor(
      @Inject(ScimServer) private readonly server: ScimServer,
      @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
      @Inject(SCIM_CONFIG) private readonly config: ResolvedConfig,
    ) {}

    @All()
    root(@Req() request: NodeLikeRequest, @Res() response: unknown): Promise<void> {
      return this.forward(request, response, []);
    }

    @All(':first')
    one(
      @Req() request: NodeLikeRequest,
      @Res() response: unknown,
      @Param('first') first: string,
    ): Promise<void> {
      return this.forward(request, response, [first]);
    }

    @All(':first/:second')
    two(
      @Req() request: NodeLikeRequest,
      @Res() response: unknown,
      @Param('first') first: string,
      @Param('second') second: string,
    ): Promise<void> {
      return this.forward(request, response, [first, second]);
    }

    private async forward(request: NodeLikeRequest, response: unknown, segments: string[]): Promise<void> {
      const adapter = this.adapterHost.httpAdapter;
      const url = new URL(request.originalUrl ?? request.url, 'http://localhost');
      let result;
      try {
        const body = await readBody(request, this.config.bodyLimit);
        result = await this.server.handle({
          method: request.method,
          path: `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`,
          query: url.searchParams,
          headers: request.headers,
          body,
          baseUrl: baseUrlOf(request, url.pathname, segments.length, this.config.trustProxy),
        });
      } catch (error) {
        const scim = isScimError(error) ? error : ScimError.internal();
        result = {
          status: scim.status,
          headers: { 'Content-Type': 'application/scim+json; charset=utf-8', ...scim.headers },
          body: scim.toJSON(),
        };
      }
      for (const [name, value] of Object.entries(result.headers)) adapter.setHeader(response, name, value);
      adapter.reply(
        response,
        result.body === undefined ? undefined : JSON.stringify(result.body),
        result.status,
      );
    }
  }
  for (const decorator of decorators) decorator(ScimController);
  return ScimController;
}

const BODYLESS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

async function readBody(request: NodeLikeRequest, limit: number): Promise<unknown> {
  if (BODYLESS.has(request.method.toUpperCase())) return undefined;
  // Express leaves bodies of types it has no parser for (application/scim+json) unread.
  const unread = request.readable === true && request.readableEnded === false;
  if (!unread || request[Symbol.asyncIterator] === undefined) return request.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > limit) throw ScimError.payloadTooLarge(`The request body is larger than ${limit} bytes.`);
    chunks.push(buffer);
  }
  return size === 0 ? request.body : Buffer.concat(chunks).toString('utf8');
}

function baseUrlOf(request: NodeLikeRequest, pathname: string, depth: number, trustProxy: boolean): string {
  const first = (value: string | string[] | undefined) => {
    const text = (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
    return text === '' ? undefined : text;
  };
  const protocol =
    (trustProxy ? first(request.headers['x-forwarded-proto']) : undefined) ?? request.protocol ?? 'http';
  const host =
    (trustProxy ? first(request.headers['x-forwarded-host']) : undefined) ??
    first(request.headers['host']) ??
    'localhost';
  const parts = pathname.replace(/\/+$/, '').split('/');
  const root = parts.slice(0, parts.length - depth).join('/');
  return `${protocol}://${host}${root}`;
}

function resolveConfig(config: ScimModuleConfig): {
  path: string;
  decorators: readonly ClassDecorator[];
  resolved: ResolvedConfig;
} {
  return {
    path: (config.path ?? 'scim/v2').replace(/^\/+|\/+$/g, ''),
    decorators: config.decorators ?? [],
    resolved: { bodyLimit: config.bodyLimit ?? 5 * 1024 * 1024, trustProxy: config.trustProxy ?? false },
  };
}

/**
 * Serves SCIM 2.0 from a NestJS application, on Express or Fastify.
 *
 * @example
 * ScimModule.forRoot({
 *   store: new MemoryScimStore(),
 *   authenticate: staticTokenAuth({ token: process.env.SCIM_TOKEN!, tenantId: 'default' }),
 * })
 */
@Module({})
export class ScimModule {
  static forRoot(options: ScimModuleOptions): DynamicModule {
    const {
      path: _path,
      decorators: _decorators,
      bodyLimit: _bodyLimit,
      trustProxy: _trustProxy,
      global: _global,
      ...serverOptions
    } = options;
    return ScimModule.build(options, [{ provide: SCIM_OPTIONS, useValue: serverOptions }], []);
  }

  static forRootAsync(options: ScimModuleAsyncOptions): DynamicModule {
    const providers: Provider[] = [];
    if (options.useFactory !== undefined) {
      providers.push({
        provide: SCIM_OPTIONS,
        useFactory: options.useFactory as (...args: unknown[]) => unknown,
        inject: (options.inject ?? []) as never[],
      });
    } else {
      const factory = options.useExisting ?? options.useClass;
      if (factory === undefined)
        throw new TypeError('ScimModule.forRootAsync needs useFactory, useClass or useExisting.');
      if (options.useClass !== undefined)
        providers.push({ provide: options.useClass, useClass: options.useClass });
      providers.push({
        provide: SCIM_OPTIONS,
        useFactory: (instance: ScimOptionsFactory) => instance.createScimOptions(),
        inject: [factory],
      });
    }
    return ScimModule.build(options, providers, options.imports ?? []);
  }

  private static build(
    config: ScimModuleConfig,
    providers: Provider[],
    imports: NonNullable<DynamicModule['imports']>,
  ): DynamicModule {
    const { path, decorators, resolved } = resolveConfig(config);
    return {
      module: ScimModule,
      global: config.global ?? false,
      imports,
      controllers: [createController(path, decorators)],
      providers: [
        ...providers,
        { provide: SCIM_CONFIG, useValue: resolved },
        { provide: ScimServer, useFactory: createServer, inject: [SCIM_OPTIONS] },
        ScimBodyParsers,
      ],
      exports: [ScimServer, SCIM_OPTIONS],
    };
  }
}
