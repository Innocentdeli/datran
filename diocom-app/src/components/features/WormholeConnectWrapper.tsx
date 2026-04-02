'use client';

import WormholeConnect from "@/components/features/WormholeConnect";

export default function WormholeConnectWrapper() {
    const handleConnect = (peerId: string) => {
        // In a real implementation via P2PHandler:
        console.log(`[WORMHOLE] Initiating subspace transfer with ${peerId}...`);
        alert(`Wormhole Connection Established! Secure P2P transfer initiating with OmniNode ${peerId}.`);
    };

    return <WormholeConnect onConnect={handleConnect} />;
}
