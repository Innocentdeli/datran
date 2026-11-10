'use client';

import { useState } from 'react';
import Link from 'next/link';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Button from '@/components/ui/Button';
import { Mail, ArrowLeft, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';

export default function ForgotPasswordPage() {
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            const res = await fetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Failed to send reset link');
            }

            setSubmitted(true);
        } catch (err) {
            setError((err as Error)?.message || 'An unexpected error occurred');
        } finally {
            setLoading(false);
        }
    };

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
                            Reset your password
                        </h1>
                        <p className="text-gray-300 text-sm leading-relaxed">
                            Enter the email associated with your account and we'll send you a secure password recovery link.
                        </p>
                    </div>

                    {submitted ? (
                        <div className="w-full flex flex-col items-center text-center py-4 relative z-20">
                            <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-4">
                                <CheckCircle2 className="w-6 h-6" />
                            </div>
                            <h2 className="text-lg font-semibold text-white mb-2">Check your inbox</h2>
                            <p className="text-sm text-gray-300 leading-relaxed mb-6">
                                If an account exists for <strong className="text-white">{email}</strong>, you will receive an email with instructions to securely reset your password.
                            </p>
                            <Link href="/auth/signin" className="w-full">
                                <Button variant="secondary" className="w-full">
                                    <ArrowLeft className="w-4 h-4 mr-2" />
                                    Return to sign in
                                </Button>
                            </Link>
                        </div>
                    ) : (
                        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4 relative z-20">
                            <div className="relative">
                                <label htmlFor="reset-email" className="sr-only">Email address</label>
                                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
                                <input
                                    id="reset-email"
                                    type="email"
                                    autoComplete="email"
                                    placeholder="Email address"
                                    required
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-sm focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500 h-12"
                                />
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
                                disabled={loading || !email}
                                className="w-full"
                            >
                                {loading ? (
                                    <Loader2 className="w-5 h-5 animate-spin" aria-label="Sending reset link" />
                                ) : (
                                    <span>Send Reset Link</span>
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
                    )}

                </div>
            </main>

            <Footer />
        </div>
    );
}
