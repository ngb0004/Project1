'use client';
import dynamic from 'next/dynamic';
const Inner = dynamic(() => import('./ProbeInner'), { ssr: false });
export function ProbeClient() {
  return <Inner />;
}
