import AsyncStorage from "@react-native-async-storage/async-storage";

import type { UnlockSession } from "@/types/screen-time";

const STORAGE_KEY = "sipfirst.unlock.sessions.v1";
const DURATION_KEY = "sipfirst.unlock.duration.minutes.v1";

export async function readUnlockSessions(): Promise<UnlockSession[]> {
  const payload = await AsyncStorage.getItem(STORAGE_KEY);
  if (!payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload) as UnlockSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeUnlockSessions(sessions: UnlockSession[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

export async function readUnlockDurationMinutes(): Promise<number> {
  const payload = await AsyncStorage.getItem(DURATION_KEY);
  const parsed = Number(payload);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30;
  }
  return parsed;
}

export async function writeUnlockDurationMinutes(minutes: number): Promise<void> {
  await AsyncStorage.setItem(DURATION_KEY, String(minutes));
}
