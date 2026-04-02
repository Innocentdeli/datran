'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams, useRouter } from 'next/navigation';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Button from '@/components/ui/Button';
import { Facebook, Mail, Lock, Loader2, ArrowRight, Fingerprint } from 'lucide-react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

export default function SignInPage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';

    const [isSignUp, setIsSignUp] = useState(false);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleWebAuthn = async () => {
        if (!email) {
            setError('Please enter your email to use Passkey.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            if (isSignUp) {
                // Register Passkey
                const res = await fetch('/api/auth/webauthn/register');
                if (!res.ok) throw new Error('Could not start passkey registration. Are you logged in? (Passkeys require an existing session or account creation first in this demo)');
                const options = await res.json();
                const attResp = await startRegistration(options);
                const verificationResp = await fetch('/api/auth/webauthn/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(attResp),
                });
                const verificationJSON = await verificationResp.json();
                if (verificationJSON.verified) {
                    setError('Passkey registered successfully! You can now sign in with it.');
                } else {
                    throw new Error('Registration failed');
                }
            } else {
                // Authenticate with Passkey
                const res = await fetch(`/api/auth/webauthn/authenticate?email=${encodeURIComponent(email)}`);
                if (!res.ok) {
                    const data = await res.json();
                    throw new Error(data.error || 'Could not start passkey authentication.');
                }
                const options = await res.json();
                const authResp = await startAuthentication(options);
                
                const verificationResp = await fetch('/api/auth/webauthn/authenticate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...authResp, _email: email }),
                });
                
                const verificationJSON = await verificationResp.json();
                if (verificationJSON.verified) {
                    // Success! Now sign in to NextAuth bypassing password
                    const signInRes = await signIn('credentials', {
                        email,
                        passkeyVerified: 'true',
                        redirect: false,
                        callbackUrl
                    });
                    if (signInRes?.error) throw new Error(signInRes.error);
                    
                    router.push(callbackUrl);
                    router.refresh();
                } else {
                    throw new Error('Passkey authentication failed.');
                }
            }
        } catch (err: any) {
            console.error(err);
            setError(err.message || 'Passkey operation failed.');
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            const res = await signIn('credentials', {
                email,
                password,
                isSignUp: isSignUp ? 'true' : 'false',
                redirect: false,
                callbackUrl
            });

            if (res?.error) {
                setError(res.error === 'CredentialsSignin' ? 'Invalid email or password' : res.error);
            } else {
                router.push(callbackUrl);
                router.refresh();
            }
        } catch (err: any) {
            setError(err.message || 'An unexpected error occurred');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center p-4 sm:p-8 font-sans">
            <Header />

            <main className="flex-1 flex flex-col items-center justify-center w-full max-w-md">
                <div className="w-full glass p-8 sm:p-12 border border-white/10 rounded-3xl flex flex-col items-center shadow-2xl relative overflow-hidden z-10">

                    {/* Decorative Glow */}
                    <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />
                    <div className="absolute -top-20 -right-20 w-40 h-40 bg-primary/20 blur-[60px] rounded-full pointer-events-none" />

                    <div className="text-center mb-8 relative z-20">
                        <h2 className="text-3xl font-bold tracking-tight mb-2">
                            {isSignUp ? 'Create ' : 'Get '}
                            <span className="text-primary">{isSignUp ? 'Account' : 'Started'}</span>
                        </h2>
                        <p className="text-gray-400 text-sm leading-relaxed">
                            {isSignUp
                                ? 'Join Datran for secure, high-speed file sharing.'
                                : 'Sign in to access your transfers and settings.'}
                        </p>
                    </div>

                    {/* Email/Password Form */}
                    <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4 mb-6 relative z-20">
                        <div className="space-y-4">
                            <div className="relative">
                                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                <input
                                    type="email"
                                    placeholder="Email Address"
                                    required
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all placeholder:text-gray-600"
                                />
                            </div>
                            <div className="relative">
                                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                <input
                                    type="password"
                                    placeholder="Password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all placeholder:text-gray-600"
                                />
                            </div>
                        </div>

                        {error && (
                            <div className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 py-2 px-3 rounded-lg">
                                {error}
                            </div>
                        )}

                        <div className="flex gap-2">
                            <Button
                                type="submit"
                                variant="primary"
                                size="lg"
                                disabled={loading || !password}
                                className="flex-1 justify-center gap-2 py-4 shadow-lg shadow-primary/20"
                                title="Login with Password"
                            >
                                {loading && password ? (
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                ) : (
                                    <span>{isSignUp ? 'Sign Up' : 'Sign In'}</span>
                                )}
                            </Button>
                            
                            <Button
                                type="button"
                                variant="secondary"
                                size="lg"
                                onClick={handleWebAuthn}
                                disabled={loading || !email}
                                className="px-4 border-primary/30 hover:border-primary hover:bg-primary/10 transition-all group"
                                title="Use Biometric Passkey"
                            >
                                {loading && !password ? (
                                     <Loader2 className="w-5 h-5 animate-spin text-primary" />
                                ) : (
                                    <Fingerprint className="w-5 h-5 text-gray-400 group-hover:text-primary transition-colors" />
                                )}
                            </Button>
                        </div>

                        <button
                            type="button"
                            onClick={() => setIsSignUp(!isSignUp)}
                            className="text-xs text-gray-400 hover:text-white transition-colors mt-2"
                        >
                            {isSignUp ? 'Already have an account? Sign In' : "Don't have an account? Create one"}
                        </button>
                    </form>

                    <div className="w-full relative flex flex-col items-center mb-6 z-20">
                        <div className="w-full flex items-center">
                            <div className="flex-grow border-t border-white/10"></div>
                            <span className="flex-shrink-0 mx-4 text-[10px] text-gray-500 font-bold uppercase tracking-widest">Or Use</span>
                            <div className="flex-grow border-t border-white/10"></div>
                        </div>
                    </div>

                    <div className="w-full grid grid-cols-2 gap-3 mb-8">
                        <Button
                            variant="secondary"
                            className="justify-center gap-2 py-3 bg-white/5 hover:bg-white/10 border-white/10"
                            onClick={() => signIn('google', { callbackUrl })}
                        >
                            <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .533 5.333.533 12S5.867 24 12.48 24c3.44 0 6.013-1.133 8.053-3.24 2.08-2.16 2.707-5.507 2.507-7.84h-10.56z" fill="currentColor" /></svg>
                            <span className="text-xs">Google</span>
                        </Button>

                        <Button
                            variant="secondary"
                            className="justify-center gap-2 py-3 bg-white/5 hover:bg-white/10 border-white/10"
                            onClick={() => signIn('facebook', { callbackUrl })}
                        >
                            <Facebook className="w-4 h-4 fill-current" />
                            <span className="text-xs">Facebook</span>
                        </Button>
                    </div>

                    <button
                        onClick={() => signIn('credentials', {
                            email: "guest@diocom.io",
                            password: "demo",
                            callbackUrl
                        })}
                        className="text-[10px] text-gray-600 hover:text-gray-400 uppercase tracking-widest transition-colors"
                    >
                        Developer Guest Access
                    </button>
                </div>
            </main>

            <Footer />
        </div>
    );
}
