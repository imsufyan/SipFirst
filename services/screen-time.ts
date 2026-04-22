import { NativeModules } from "react-native";

import type { ManagedApp } from "@/types/screen-time";

type ScreenTimeNativeModule = {
  requestAuthorization?: () => Promise<boolean>;
  selectManagedApps?: () => Promise<ManagedApp[]>;
  presentFamilyActivityPicker?: () => Promise<ManagedApp[]>;
  setShieldState?: (token: string, shielded: boolean) => Promise<void>;
  setTemporaryUnlock?: (token: string, expiresAtMs: number) => Promise<void>;
  getScreenTimeSummary?: (token: string) => Promise<number>;
};

const nativeModule = NativeModules.ScreenTimeManager as ScreenTimeNativeModule | undefined;

const fallbackApps: ManagedApp[] = [];

export async function requestAuthorization(): Promise<boolean> {
  if (nativeModule?.requestAuthorization) {
    return nativeModule.requestAuthorization();
  }
  return true;
}

export async function selectManagedApps(): Promise<ManagedApp[]> {
  if (nativeModule?.selectManagedApps) {
    return nativeModule.selectManagedApps();
  }
  return fallbackApps;
}

export async function presentFamilyActivityPicker(): Promise<ManagedApp[]> {
  if (nativeModule?.presentFamilyActivityPicker) {
    return nativeModule.presentFamilyActivityPicker();
  }

  return fallbackApps;
}

export async function setShieldState(token: string, isShielded: boolean): Promise<void> {
  if (nativeModule?.setShieldState) {
    return nativeModule.setShieldState(token, isShielded);
  }

  const app = fallbackApps.find((candidate) => candidate.token === token);
  if (app) {
    app.isShielded = isShielded;
  }
}

export async function setTemporaryUnlock(token: string, expiresAtMs: number): Promise<void> {
  if (nativeModule?.setTemporaryUnlock) {
    return nativeModule.setTemporaryUnlock(token, expiresAtMs);
  }

  if (nativeModule?.setShieldState) {
    return nativeModule.setShieldState(token, false);
  }

  const app = fallbackApps.find((candidate) => candidate.token === token);
  if (app) {
    app.isShielded = false;
  }
}

export async function getScreenTimeSummaryMinutes(token: string): Promise<number> {
  if (nativeModule?.getScreenTimeSummary) {
    return nativeModule.getScreenTimeSummary(token);
  }

  const hash = token.length % 7;
  return 10 + hash * 5;
}
