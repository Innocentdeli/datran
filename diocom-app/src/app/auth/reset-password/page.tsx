'use client';

import { useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Button from '@/components/ui/Button';
import { Lock, ArrowLeft, CheckCircle2, Loader2, AlertCircle, ShieldCheck } from 'lucide-react';

function ResetPasswordForm() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const token = searchParams.get('token');

    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!token) {
        return (
            <div className="w-full flex flex-col items-center text-center py-4 relative z-20">
                <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-4">
                    <AlertCircle className="w-6 h-6" />
                </div>
                <h2 className="text-lg font-semibold text-white mb-2">Invalid or Missing Token</h2>
                <p className="text-sm text-gray-300 leading-relaxed mb-6">
                    This password reset link is invalid, incomplete, or has expired. Please request a new recovery link.
                </p>
                <Link href="/auth/forgot-password" className="w-full">
                    <Button variant="primary" className="w-full">
                        Request New Reset Link
                    </Button>
                </Link>
            </div>
        );
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        if (password.length < 8) {
            setError('Password must be at least 8 characters in length.');
            return;
        }

        if (password !== confirmPassword) {
            setError('Passwords do not match. Please re-enter.');
            return;
        }

        setLoading(true);

        try {
            const res = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, newPassword: password })
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Failed to reset password');
            }

            setSuccess(true);
        } catch (err) {
            setError((err as Error)?.message || 'An unexpected error occurred');
        } finally {
            setLoading(false);
        }
    };

    if (success) {
        return (
            <div className="w-full flex flex-col items-center text-center py-4 relative z-20">
                <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-4">
                    <CheckCircle2 className="w-6 h-6" />
                </div>
                <h2 className="text-lg font-semibold text-white mb-2">Password Reset Complete</h2>
                <p className="text-sm text-gray-300 leading-relaxed mb-6">
                    Your password has been successfully updated. All previous sessions have been invalidated for security.
                </p>
                <Link href="/auth/signin" className="w-full">
                    <Button variant="primary" className="w-full">
                        Sign In Now
                    </Button>
                </Link>
            </div>
        );
    }

    return (
        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4 relative z-20">
            <div className="space-y-4">
                <div className="relative">
                    <label htmlFor="new-password" className="sr-only">New Password</label>
                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
                    <input
                        id="new-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder="New Password (min 8 characters)"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-sm focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500 h-12"
                    />
                </div>

                <div className="relative">
                    <label htmlFor="confirm-password" className="sr-only">Confirm Password</label>
                    <ShieldCheck className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
                    <input
                        id="confirm-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder="Confirm New Password"
                        required
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-sm focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500 h-12"
                    />
                </div>
            </div>

            {error && (
                <div role="alert" className="flex items-center gap-2 text-sm text-red-200 bg-red-500/10 border border-red-400/25 py-2.5 px-3 rounded-lg">
                    <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                    <span>{error}</span>
                </div>
            )}

            <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={loading || !password || !confirmPassword}
                className="w-full"
            >
                {loading ? (
                    <Loader2 className="w-5 h-5 animate-spin" aria-label="Updating password" />
                ) : (
                    <span>Update Password</span>
                )}
            </Button>

            <div className="text-center mt-3">
                <Link
                    href="/auth/signin"
                    className="inline-flex items-center text-sm text-gray-400 hover:text-white transition-colors"
                >
                    <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
                    Back to sign in
                </Link>
            </div>
        </form>
    );
}

export default function ResetPasswordPage() {
    return (
        <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
            <Header />

            <main id="main" className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center">
                <div className="panel relative z-10 flex w-full flex-col items-center overflow-hidden p-6 sm:p-10">

                    {/* Decorative Glow */}
                    <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />
                    <div className="absolute -top-20 -right-20 w-40 h-40 bg-primary/20 blur-[60px] rounded-full pointer-events-none" />

                    <div className="text-center mb-8 relative z-20">
                        <h1 className="text-2xl font-bold tracking-tight mb-2 text-white">
                            Choose a new password
                        </h1>
                        <p className="text-gray-300 text-sm leading-relaxed">
                            Create a strong, unique password to protect your encrypted transfers and account.
                        </p>
                    </div>

                    <Suspense fallback={
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="w-6 h-6 animate-spin text-primary" />
                        </div>
                    }>
                        <ResetPasswordForm />
                    </Suspense>

                </div>
            </main>

            <Footer />
        </div>
    );
}
