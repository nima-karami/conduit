export async function stopAgentsBeforeQuit(d: {
  stop(): Promise<{ ok: boolean; reason?: string }>;
  failure(reason: string): Promise<'retry' | 'leave' | 'cancel'>;
  finish(): void;
  cancel(): void;
}): Promise<void> {
  for (;;) {
    let result: { ok: boolean; reason?: string };
    try {
      result = await d.stop();
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) {
      d.finish();
      return;
    }
    const choice = await d.failure(result.reason ?? 'The background service is unavailable.');
    if (choice === 'retry') continue;
    if (choice === 'leave') d.finish();
    else d.cancel();
    return;
  }
}
