'use client';

import { useId, useState } from 'react';
import { Lock, AlertCircle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { buttonClasses } from '@/components/ui/Button';

interface PasswordGateProps {
    shareId: string;
}

export default function PasswordGate({ shareId }: PasswordGateProps) {
    const [password, setPassword] = useState('');
    const [visible, setVisible] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const router = useRouter();
    const inputId = useId();
    const errorId = useId();

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
        } catch {
            setError('That password is not correct. Check with the sender and try again.');
            setLoading(false);
        }
    };

    return (
        <div className="mx-auto flex min-h-80 w-full max-w-sm flex-col items-center justify-center px-2 py-8 text-center">
            <span className="mb-5 grid h-14 w-14 place-items-center rounded-2xl border border-primary/25 bg-primary/10 text-primary" aria-hidden="true">
                <Lock className="h-7 w-7" />
            </span>

            <h1 className="text-xl font-semibold text-white">This file is password protected</h1>
            <p className="mb-6 mt-2 text-sm text-gray-300">Enter the password the sender gave you to view and download it.</p>

            <form onSubmit={handleUnlock} className="flex w-full flex-col gap-3 text-left">
                <label htmlFor={inputId} className="text-sm font-medium text-gray-200">Password</label>
                <div className="relative">
                    <input
                        id={inputId}
                        type={visible ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="off"
                        autoFocus
                        aria-invalid={!!error}
                        aria-describedby={error ? errorId : undefined}
                        className="h-12 w-full rounded-xl border border-white/10 bg-black/40 pl-4 pr-12 text-base text-white placeholder:text-gray-500 focus:border-primary/60 focus:outline-none aria-[invalid=true]:border-red-400/60"
                    />
                    <button
                        type="button"
                        onClick={() => setVisible((v) => !v)}
                        aria-label={visible ? 'Hide password' : 'Show password'}
                        aria-pressed={visible}
                        className="absolute right-1.5 top-1.5 grid h-9 w-9 place-items-center rounded-lg text-gray-400 hover:text-white"
                    >
                        {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                    </button>
                </div>

                {error && (
                    <p id={errorId} role="alert" className="flex items-start gap-2 text-sm text-red-300">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        {error}
                    </p>
                )}

                <button type="submit" disabled={loading || !password} className={buttonClasses('primary', 'lg', 'mt-1 w-full')}>
                    {loading ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : null}
                    {loading ? 'Checking…' : 'Unlock file'}
                </button>
            </form>
        </div>
    );
}
