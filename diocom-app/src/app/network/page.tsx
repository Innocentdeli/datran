import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import ConnectionInfo from '@/components/features/ConnectionInfo';
import P2PTransfer from '@/components/features/P2PTransfer';

export default function NetworkPage() {
    return (
        <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center p-4 sm:p-8 font-sans">
            <Header />

            <main className="max-w-7xl w-full flex-1 flex flex-col gap-8">
                <h2 className="text-3xl font-black uppercase italic tracking-tighter">Network</h2>

                <div className="max-w-xl w-full">
                    <ConnectionInfo title="Your connection to this server" />
                </div>

                <div>
                    <h3 className="text-xl font-bold mb-4">Direct P2P Transfer (WebRTC)</h3>
                    <P2PTransfer />
                </div>
            </main>

            <Footer />
        </div>
    );
}
