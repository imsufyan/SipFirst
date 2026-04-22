import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import {
  presentFamilyActivityPicker,
  requestAuthorization,
  selectManagedApps,
  setShieldState,
  setTemporaryUnlock,
} from "@/services/screen-time";
import {
  readUnlockDurationMinutes,
  readUnlockSessions,
  writeUnlockDurationMinutes,
  writeUnlockSessions,
} from "@/services/unlock-store";
import type { ManagedApp, UnlockDurationOption, UnlockSession } from "@/types/screen-time";

type SipFirstContextValue = {
  managedApps: ManagedApp[];
  authorizationGranted: boolean;
  loading: boolean;
  requestAccess: () => Promise<void>;
  refreshManagedApps: () => Promise<ManagedApp[]>;
  openPickerAndSync: () => Promise<ManagedApp[]>;
  unlockForChallengeSuccess: (token: string) => Promise<void>;
  relockExpiredApps: () => Promise<void>;
  getRemainingSeconds: (token: string) => number;
  unlockDurationMinutes: UnlockDurationOption;
  setUnlockDurationMinutes: (minutes: UnlockDurationOption) => Promise<void>;
};

const SipFirstContext = createContext<SipFirstContextValue | null>(null);

function nowMs() {
  return Date.now();
}

export function SipFirstProvider({ children }: { children: React.ReactNode }) {
  const [managedApps, setManagedApps] = useState<ManagedApp[]>([]);
  const [authorizationGranted, setAuthorizationGranted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unlockSessions, setUnlockSessions] = useState<UnlockSession[]>([]);
  const [unlockDurationMinutes, setUnlockDurationMinutesState] = useState<UnlockDurationOption>(30);

  const refreshManagedApps = useCallback(async () => {
    const apps = await selectManagedApps();
    setManagedApps(apps);
    return apps;
  }, []);

  const openPickerAndSync = useCallback(async () => {
    const apps = await presentFamilyActivityPicker();
    setManagedApps(apps);
    return apps;
  }, []);

  const relockExpiredApps = useCallback(async () => {
    const sessions = await readUnlockSessions();
    const validSessions = sessions.filter((session) => session.expiresAtMs > nowMs());
    const expired = sessions.filter((session) => session.expiresAtMs <= nowMs());

    for (const session of expired) {
      await setShieldState(session.token, true);
    }

    await writeUnlockSessions(validSessions);
    setUnlockSessions(validSessions);
  }, []);

  const requestAccess = useCallback(async () => {
    const granted = await requestAuthorization();
    setAuthorizationGranted(granted);

    if (granted) {
      await refreshManagedApps();
    }
  }, [refreshManagedApps]);

  const unlockForChallengeSuccess = useCallback(
    async (token: string) => {
      const expiresAtMs = nowMs() + unlockDurationMinutes * 60 * 1000;
      const sessions = await readUnlockSessions();
      const next = sessions.filter((session) => session.token !== token).concat({ token, expiresAtMs });

      await setTemporaryUnlock(token, expiresAtMs);
      await writeUnlockSessions(next);
      setUnlockSessions(next);
      await refreshManagedApps();
    },
    [refreshManagedApps, unlockDurationMinutes]
  );

  const setUnlockDurationMinutes = useCallback(async (minutes: UnlockDurationOption) => {
    setUnlockDurationMinutesState(minutes);
    await writeUnlockDurationMinutes(minutes);
  }, []);

  const getRemainingSeconds = useCallback(
    (token: string) => {
      const session = unlockSessions.find((candidate) => candidate.token === token);
      if (!session) {
        return 0;
      }

      return Math.max(0, Math.floor((session.expiresAtMs - nowMs()) / 1000));
    },
    [unlockSessions]
  );

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const persistedDuration = await readUnlockDurationMinutes();
        if (
          persistedDuration === 15 ||
          persistedDuration === 30 ||
          persistedDuration === 60
        ) {
          setUnlockDurationMinutesState(persistedDuration);
        }
        await relockExpiredApps();
        await requestAccess();
      } finally {
        setLoading(false);
      }
    };

    bootstrap();
  }, [relockExpiredApps, requestAccess]);

  useEffect(() => {
    const id = setInterval(() => {
      relockExpiredApps();
    }, 5000);

    return () => clearInterval(id);
  }, [relockExpiredApps]);

  const value = useMemo<SipFirstContextValue>(
    () => ({
      managedApps,
      authorizationGranted,
      loading,
      requestAccess,
      refreshManagedApps,
      openPickerAndSync,
      unlockForChallengeSuccess,
      relockExpiredApps,
      getRemainingSeconds,
      unlockDurationMinutes,
      setUnlockDurationMinutes,
    }),
    [
      authorizationGranted,
      getRemainingSeconds,
      loading,
      managedApps,
      openPickerAndSync,
      refreshManagedApps,
      relockExpiredApps,
      requestAccess,
      setUnlockDurationMinutes,
      unlockDurationMinutes,
      unlockForChallengeSuccess,
    ]
  );

  return <SipFirstContext.Provider value={value}>{children}</SipFirstContext.Provider>;
}

export function useSipFirst() {
  const value = useContext(SipFirstContext);
  if (!value) {
    throw new Error("useSipFirst must be used within SipFirstProvider");
  }
  return value;
}
