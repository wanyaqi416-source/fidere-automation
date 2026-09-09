export type DualSessionPreflight = {
  checkAdmin(): Promise<void>;
  checkClient(): Promise<void>;
  markReady(clientReady: boolean, adminReady: boolean): void;
};

export async function runDualSessionPreflight(
  preflight: DualSessionPreflight
): Promise<void> {
  // Admin remains first so an expired manually captured session blocks before Client mutation.
  await preflight.checkAdmin();
  await preflight.checkClient();
  preflight.markReady(true, true);
}

