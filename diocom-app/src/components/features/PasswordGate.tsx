'use client';

import { useState } from 'react';
import { Lock, ArrowRight, AlertCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Button from '@/components/ui/Button';

interface PasswordGateProps {
    shareId: string;
}

export default function PasswordGate({ shareId }: PasswordGateProps) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const router = useRouter();

    const handleUnlock = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            const res = await fetch('/api/unlock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shareId, password }),
            });

            if (!res.ok) {
                throw new Error('Incorrect password');
            }

            // Refresh to bypass server check
            router.refresh();
        } catch (err) {
            setError('Access Denied: Invalid Password');
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-[400px] w-full max-w-md mx-auto p-6 text-center">
            <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mb-6 border border-red-500/20 shadow-[0_0_30px_rgba(239,68,68,0.2)]">
                <Lock className="w-10 h-10 text-red-500" />
            </div>

            <h2 className="text-2xl font-bold mb-2">Restricted Access</h2>
            <p className="text-gray-400 mb-8 text-sm">
                This file is encrypted with a secure key. <br />Enter the password to decrypt and view.
            </p>

            <form onSubmit={handleUnlock} className="w-full flex flex-col gap-4">
                <div className="relative">
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter Password"
                        className="w-full bg-black/40 border border-white/10 rounded-xl px-5 py-4 text-white placeholder-white/30 focus:outline-none focus:border-red-500/50 transition-colors text-center text-lg tracking-widest"
                        autoFocus
                    />
                </div>

                {error && (
                    <div className="flex items-center justify-center gap-2 text-red-400 text-sm font-bold bg-red-500/10 p-2 rounded-lg">
                        <AlertCircle className="w-4 h-4" />
                        {error}
                    </div>
                )}

                <Button
                    variant="danger"
                    size="lg"
                    className="w-full justify-center"
                    disabled={loading || !password}
                >
                    {loading ? 'Decrypting...' : 'Unlock Content'} <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
            </form>
        </div>
    );
}
