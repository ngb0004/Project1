import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const KEY = 'dive.device-id';

/** One random id per install, kept in the keychain / keystore. One session per device per case version. */
export async function loadDeviceId(): Promise<string> {
  try {
    const existing = await SecureStore.getItemAsync(KEY);
    if (existing) return existing;
    const id = randomUUID();
    await SecureStore.setItemAsync(KEY, id);
    return id;
  } catch {
    // Secure storage unavailable: the id lasts for this launch only.
    return randomUUID();
  }
}
