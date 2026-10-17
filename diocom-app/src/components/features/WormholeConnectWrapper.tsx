'use client';

import ConnectionInfo from '@/components/features/ConnectionInfo';

/**
 * Kept under its old name because the share page imports it. It used to render a simulated
 * "Wormhole" peer scanner (random peer ids, fake distances and a protocol label derived from
 * API availability); it now shows the measured connection protocol instead.
 */
export default function WormholeConnectWrapper() {
    return <ConnectionInfo />;
}
