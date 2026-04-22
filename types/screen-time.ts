export type ManagedApp = {
  token: string;
  displayName: string;
  isShielded: boolean;
};

export type UnlockSession = {
  token: string;
  expiresAtMs: number;
};

export type UnlockDurationOption = 15 | 30 | 60;
