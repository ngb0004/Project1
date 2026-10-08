import { useEffect, useState } from 'react';
import { loadDeviceId } from './device-id';

export function useDeviceId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadDeviceId().then((v) => alive && setId(v));
    return () => {
      alive = false;
    };
  }, []);
  return id;
}
