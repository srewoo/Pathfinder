import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `chrome.debugger.sendCommand` has no timeout of its own. A renderer that
 * never answers left an exploration stalled with nothing in the log — these
 * tests pin the ceiling that now bounds it.
 */
const sendCommand = vi.fn();
const attach = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('chrome', {
    debugger: {
      attach,
      sendCommand,
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    tabs: { onRemoved: { addListener: vi.fn() } },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadClient() {
  vi.resetModules();
  return import('../../../src/core/cdp/cdp-client');
}

describe('CDP command timeout', () => {
  it('given_a_command_that_never_settles_then_it_rejects_rather_than_hanging', async () => {
    sendCommand.mockReturnValue(new Promise(() => undefined));
    const { attach: doAttach, evaluate } = await loadClient();
    await doAttach(1);

    const pending = evaluate(1, '1 + 1');
    const assertion = expect(pending).rejects.toThrow(/did not respond within/i);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });

  it('given_a_timeout_then_the_error_names_the_method_and_the_tab', async () => {
    sendCommand.mockReturnValue(new Promise(() => undefined));
    const { attach: doAttach, evaluate } = await loadClient();
    await doAttach(7);

    const pending = evaluate(7, '1');
    const assertion = expect(pending).rejects.toThrow(/Runtime\.evaluate on tab 7/);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });

  it('given_a_command_that_answers_in_time_then_its_value_is_returned', async () => {
    sendCommand.mockResolvedValue({ result: { type: 'number', value: 2 } });
    const { attach: doAttach, evaluate } = await loadClient();
    await doAttach(1);

    await expect(evaluate<number>(1, '1 + 1')).resolves.toBe(2);
  });

  // A slow-but-answering renderer must not be cut off early.
  it('given_a_command_answering_just_under_the_ceiling_then_it_still_succeeds', async () => {
    sendCommand.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ result: { type: 'number', value: 5 } }), 29_000)
        )
    );
    const { attach: doAttach, evaluate } = await loadClient();
    await doAttach(1);

    const pending = evaluate<number>(1, '5');
    await vi.advanceTimersByTimeAsync(29_500);
    await expect(pending).resolves.toBe(5);
  });

  it('given_a_command_that_rejects_then_the_original_error_survives', async () => {
    sendCommand.mockRejectedValue(new Error('No tab with given id'));
    const { attach: doAttach, evaluate } = await loadClient();
    await doAttach(1);

    await expect(evaluate(1, '1')).rejects.toThrow('No tab with given id');
  });

  // waitForDomSettle is best-effort by contract: a stalled renderer must not
  // fail the step that called it.
  it('given_a_stalled_renderer_then_waitForDomSettle_resolves_instead_of_throwing', async () => {
    sendCommand.mockReturnValue(new Promise(() => undefined));
    const { attach: doAttach, waitForDomSettle } = await loadClient();
    await doAttach(1);

    const pending = waitForDomSettle(1, 2_000);
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(pending).resolves.toBeUndefined();
  });

  // Its own budget is well under the global ceiling, so a settle wait cannot
  // cost 30s on a page that never runs the script.
  it('given_waitForDomSettle_then_it_gives_up_far_sooner_than_the_global_ceiling', async () => {
    sendCommand.mockReturnValue(new Promise(() => undefined));
    const { attach: doAttach, waitForDomSettle } = await loadClient();
    await doAttach(1);

    let settled = false;
    void waitForDomSettle(1, 2_000).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(true);
  });
});
