import { describe, it, expect } from 'vitest';
import { timestamped } from '../../src/extension.js';

/**
 * The log had no clock, so a ten-second gap between focusing the window and
 * the panel updating was undiagnosable: the debounce is 300 ms and `status`
 * reported 800 ms, and every candidate explanation for the missing nine
 * seconds looked the same on screen.
 */
describe('timestamped output channel', () => {
  const fake = () => {
    const lines: string[] = [];
    const calls: string[] = [];
    const inner = {
      name: 'TFVC',
      lines,
      appendLine: (v: string) => void lines.push(v),
      append: (v: string) => void calls.push(`append:${v}`),
      replace: (v: string) => void calls.push(`replace:${v}`),
      clear: () => void calls.push('clear'),
      show: () => void calls.push('show'),
      hide: () => void calls.push('hide'),
      dispose: () => void calls.push('dispose'),
    };
    return { inner, lines, calls };
  };

  it('prefixes each line with a local time to the millisecond', () => {
    const { inner, lines } = fake();

    timestamped(inner as never).appendLine('window focused - refreshing');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} window focused - refreshing$/);
  });

  it('pads, so lines stay column-aligned and sort correctly', () => {
    // `9:7:3.45` reads as a different length every line and cannot be scanned.
    const { inner, lines } = fake();
    const channel = timestamped(inner as never);
    for (let i = 0; i < 40; i++) channel.appendLine('x');

    const widths = new Set(lines.map((l) => l.indexOf(' ')));
    expect(widths, 'the stamp changes width between lines').toEqual(new Set([12]));
  });

  it('forwards everything else to the real channel', () => {
    // A wrapper that quietly dropped dispose() would leak the channel, and
    // one that dropped show() would break the "TFVC: Show Log" command.
    const { inner, calls } = fake();
    const channel = timestamped(inner as never);

    channel.append('partial');
    channel.replace('all of it');
    channel.clear();
    channel.show();
    channel.hide();
    channel.dispose();

    expect(calls).toEqual([
      'append:partial',
      'replace:all of it',
      'clear',
      'show',
      'hide',
      'dispose',
    ]);
    expect(channel.name).toBe('TFVC');
  });

  it('stops forwarding append/appendLine once the pushed disposable is disposed', () => {
    // A scan or a command can still be finishing async work after
    // deactivation -- nothing cancels an in-flight `tf` -- and writing to a
    // channel VS Code has already torn down is worse than losing that line.
    const { inner, lines, calls } = fake();
    const subscriptions: { dispose(): void }[] = [];
    const channel = timestamped(inner as never, subscriptions);

    channel.appendLine('before deactivation');
    expect(lines).toHaveLength(1);

    expect(subscriptions, 'no disposable was pushed for the wrapper to observe').toHaveLength(1);
    for (const d of subscriptions) d.dispose();

    channel.appendLine('after deactivation');
    channel.append('after deactivation too');

    expect(lines).toHaveLength(1);
    // `append` writes to `calls`, not `lines` -- the assertion above alone
    // cannot fail no matter what `append` does, since it never touches
    // `lines` even in the correct implementation.
    expect(calls, 'append kept forwarding after disposal').toEqual([]);
  });

  it('still forwards everything when no subscriptions array is given', () => {
    // Optional so every existing call site keeps compiling.
    const { inner, lines } = fake();
    const channel = timestamped(inner as never);

    channel.appendLine('x');

    expect(lines).toHaveLength(1);
  });
});
