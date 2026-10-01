import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { VIETNAM_TIMEZONE } from './timezone';

const SRC = join(__dirname, '..', '..');

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFilesUnder(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

/** Reads the source rather than calling anything: a @Cron schedule is a decorator argument, so a missing timezone only fails on a host in another zone. */
describe('cron schedules', () => {
  const sources = tsFilesUnder(SRC)
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
    .filter(({ text }) => text.includes('@Cron('));

  it('finds the cron jobs (guards against this test silently matching nothing)', () => {
    expect(sources.length).toBeGreaterThanOrEqual(3);
  });

  it.each(
    sources.length
      ? sources.map(({ path, text }) => [path.slice(SRC.length + 1), text])
      : [['<no cron files found>', '']],
  )('%s pins every @Cron to the shop timezone', (_name, text) => {
    // Matches each @Cron(...) up to the first ')' - cron arguments never nest parens in practice.
    const calls = text.match(/@Cron\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain('timeZone: VIETNAM_TIMEZONE');
    }
  });

  it('resolves to a zone Intl actually knows', () => {
    expect(() =>
      new Intl.DateTimeFormat('vi-VN', { timeZone: VIETNAM_TIMEZONE }).format(
        new Date(),
      ),
    ).not.toThrow();
  });
});
