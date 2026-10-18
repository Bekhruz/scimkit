import { describe, expect, it, vi } from 'vitest';
import { consoleLogger, silentLogger } from 'scimkit';

describe('loggers', () => {
  it('prints only warnings and errors to the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    consoleLogger.debug('d');
    consoleLogger.info('i');
    consoleLogger.warn('w', { a: 1 });
    consoleLogger.error('e');
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[scimkit] w', { a: 1 });
    expect(error).toHaveBeenCalledWith('[scimkit] e', '');
    vi.restoreAllMocks();
  });

  it('can discard everything', () => {
    const spies = (['debug', 'info', 'warn', 'error', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    silentLogger.debug('x');
    silentLogger.info('x');
    silentLogger.warn('x');
    silentLogger.error('x');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
