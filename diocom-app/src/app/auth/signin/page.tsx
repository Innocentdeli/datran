'use client';

import { useState, useEffect } from 'react';
import { signIn, getProviders } from 'next-auth/react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Button from '@/components/ui/Button';
import { Facebook, Mail, Lock, Loader2, Fingerprint, AtSign } from 'lucide-react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

export default function SignInPage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';

    const [isSignUp, setIsSignUp] = useState(false);
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [availableProviders, setAvailableProviders] = useState<{ google?: boolean; facebook?: boolean }>({});

    useEffect(() => {
        getProviders().then((providers) => {
            if (providers) {
                setAvailableProviders({
                    google: !!providers.google,
                    facebook: !!providers.facebook,
                });
            }
        }).catch(() => {});
    }, []);

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
                if (!res.ok) throw new Error('Could not start passkey registration. Please sign in first, then add a passkey to your account.');
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
                if (verificationJSON.verified && verificationJSON.loginToken) {
                    // Exchange the server-issued, single-use passkey token for a session
                    const signInRes = await signIn('credentials', {
                        passkeyToken: verificationJSON.loginToken,
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
        } catch (err) {
            console.error(err);
            setError((err as Error)?.message || 'Passkey operation failed.');
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        if (isSignUp) {
            const cleanUser = username.trim().toLowerCase();
            if (!cleanUser || cleanUser.length < 3 || cleanUser.length > 30 || !/^[a-z0-9_]+$/.test(cleanUser)) {
                setError('Username must be 3-30 lowercase characters (letters, numbers, underscores).');
                setLoading(false);
                return;
            }
        }

        try {
            const res = await signIn('credentials', {
                email,
                password,
                username: isSignUp ? username.trim().toLowerCase() : undefined,
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
                            {isSignUp ? 'Create your account' : 'Sign in to Datran'}
                        </h1>
                        <p className="text-gray-300 text-sm leading-relaxed">
                            {isSignUp
                                ? 'Free accounts get larger uploads, personal handles, and instant transfer vaults.'
                                : 'Sign in to access your transfers and settings.'}
                        </p>
                    </div>

                    {/* Email/Password Form */}
                    <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4 mb-6 relative z-20">
                        <div className="space-y-4">
                            {isSignUp && (
                                <div className="relative">
                                    <label htmlFor="signin-username" className="sr-only">Username</label>
                                    <AtSign className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
                                    <input
                                        id="signin-username"
                                        type="text"
                                        autoComplete="username"
                                        placeholder="Username (e.g. alex_99)"
                                        required={isSignUp}
                                        value={username}
                                        onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                                        className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-sm focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500 h-12 font-mono"
                                    />
                                </div>
                            )}
                            <div className="relative">
                                <label htmlFor="signin-email" className="sr-only">Email address</label>
                                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
                                <input
                                    id="signin-email"
                                    type="email"
                                    autoComplete="email"
                                    placeholder="Email address"
                                    required
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-sm focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500 h-12"
                                />
                            </div>
                            <div className="relative">
                                <label htmlFor="signin-password" className="sr-only">Password</label>
                                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
                                <input
                                    id="signin-password"
                                    type="password"
                                    autoComplete={isSignUp ? 'new-password' : 'current-password'}
                                    placeholder="Password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-sm focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500 h-12"
                                />
                            </div>
                            {!isSignUp && (
                                <div className="flex justify-end -mt-1">
                                    <Link
                                        href="/auth/forgot-password"
                                        className="text-xs text-primary/80 hover:text-primary transition-colors focus:outline-none focus:underline"
                                    >
                                        Forgot password?
                                    </Link>
                                </div>
                            )}
                        </div>

                        {error && (
                            <div role="alert" className="text-sm text-red-200 bg-red-500/10 border border-red-400/25 py-2 px-3 rounded-lg">
                                {error}
                            </div>
                        )}

                        <div className="flex gap-2">
                            <Button
                                type="submit"
                                variant="primary"
                                size="lg"
                                disabled={loading || !password}
                                className="flex-1"
                            >
                                {loading && password ? (
                                    <Loader2 className="w-5 h-5 animate-spin" aria-label="Signing in" />
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
                                className="px-4 group"
                                title="Sign in with a passkey"
                                aria-label="Sign in with a passkey"
                            >
                                {loading && !password ? (
                                     <Loader2 className="w-5 h-5 animate-spin text-primary" />
                                ) : (
                                    <Fingerprint className="w-5 h-5 text-gray-300 group-hover:text-primary transition-colors" aria-hidden="true" />
                                )}
                            </Button>
                        </div>

                        <button
                            type="button"
                            onClick={() => setIsSignUp(!isSignUp)}
                            className="text-sm text-gray-300 hover:text-white transition-colors mt-2 rounded"
                        >
                            {isSignUp ? 'Already have an account? Sign In' : "Don't have an account? Create one"}
                        </button>
                    </form>

                    {(availableProviders.google || availableProviders.facebook) && (
                        <>
                            <div className="w-full relative flex flex-col items-center mb-6 z-20">
                                <div className="w-full flex items-center">
                                    <div className="flex-grow border-t border-white/10"></div>
                                    <span className="flex-shrink-0 mx-4 text-xs text-gray-400">or continue with</span>
                                    <div className="flex-grow border-t border-white/10"></div>
                                </div>
                            </div>

                            <div className={`w-full grid ${availableProviders.google && availableProviders.facebook ? 'grid-cols-2' : 'grid-cols-1'} gap-3`}>
                                {availableProviders.google && (
                                    <Button
                                        variant="secondary"
                                        className="w-full"
                                        onClick={() => signIn('google', { callbackUrl })}
                                    >
                                        <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .533 5.333.533 12S5.867 24 12.48 24c3.44 0 6.013-1.133 8.053-3.24 2.08-2.16 2.707-5.507 2.507-7.84h-10.56z" fill="currentColor" /></svg>
                                        <span>Google</span>
                                    </Button>
                                )}

                                {availableProviders.facebook && (
                                    <Button
                                        variant="secondary"
                                        className="w-full"
                                        onClick={() => signIn('facebook', { callbackUrl })}
                                    >
                                        <Facebook className="w-4 h-4 fill-current" aria-hidden="true" />
                                        <span>Facebook</span>
                                    </Button>
                                )}
                            </div>
                        </>
                    )}

                </div>
            </main>

            <Footer />
        </div>
    );
}
