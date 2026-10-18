/** A response as the checks see it. */
export interface CheckResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON, the raw text when the body is not JSON, or undefined when empty. */
  readonly body: unknown;
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  headers?: Readonly<Record<string, string>>;
  fetch: typeof fetch;
  timeoutMs: number;
}

/** A small HTTP client for one SCIM endpoint. */
export class ScimClient {
  private readonly baseUrl: string;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<CheckResponse> {
    const response = await this.options.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/scim+json, application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/scim+json' }),
        ...(this.options.token === undefined ? {} : { authorization: `Bearer ${this.options.token}` }),
        ...this.options.headers,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, headers: response.headers, body: parsed };
  }
}
