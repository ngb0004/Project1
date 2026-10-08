import { randomUUID } from 'expo-crypto';

const KEY = 'dive.device-id';

/** One random id per browser profile, kept in localStorage. One session per device per case version. */
export async function loadDeviceId(): Promise<string> {
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing) return existing;
    const id = randomUUID();
    window.localStorage.setItem(KEY, id);
    return id;
  } catch {
    // Storage blocked (private mode, disabled cookies): the id lasts for this page load only.
    return randomUUID();
  }
}
