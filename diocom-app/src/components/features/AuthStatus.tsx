'use client';

import { signIn, signOut, useSession } from 'next-auth/react';
import { LogIn, LogOut, User } from 'lucide-react';
import Button from '@/components/ui/Button';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function AuthStatus() {
    const { data: session, status } = useSession();
    const router = useRouter();

    if (status === 'loading') {
        return (
            <div className="flex items-center gap-4 animate-pulse">
                <div className="h-4 w-20 bg-white/5 rounded"></div>
                <div className="h-4 w-20 bg-white/5 rounded"></div>
            </div>
        );
    }

    if (session) {
        const isGuest = session.user?.email === 'guest@diocom.io';

        return (
            <div className="flex items-center gap-4">
                <Link href="/" className="text-[11px] font-bold text-gray-400 hover:text-white transition uppercase tracking-widest px-2">
                    New Upload
                </Link>

                <div className="h-3 w-[1px] bg-white/10"></div>

                <Link href="/dashboard" className="text-[11px] font-bold text-gray-400 hover:text-primary transition uppercase tracking-widest px-2">
                    My Transfers
                </Link>

                {(session.user as any).role === 'admin' && (
                    <>
                        <div className="h-3 w-[1px] bg-white/10"></div>
                        <Link href="/admin" className="text-[11px] font-bold text-red-500/60 hover:text-red-400 transition uppercase tracking-widest px-2">
                            Admin
                        </Link>
                    </>
                )}

                <div className="h-8 w-[1px] bg-white/10 mx-1"></div>

                <div className="flex items-center gap-3 pl-2">
                    <div className="relative">
                        {session.user?.image ? (
                            <img
                                src={session.user.image}
                                alt={session.user.name || 'User'}
                                className="w-8 h-8 rounded-xl border border-white/10 shadow-lg"
                            />
                        ) : (
                            <div className="w-8 h-8 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center">
                                <User className="w-4 h-4 text-white/30" />
                            </div>
                        )}
                        {isGuest && (
                            <div className="absolute -top-1 -right-1 w-3 h-3 bg-primary rounded-full border-2 border-[#050505] shadow-[0_0_8px_rgba(0,242,255,0.5)]" />
                        )}
                    </div>

                    <div className="hidden lg:flex flex-col items-start leading-none">
                        <span className="text-xs font-bold text-white mb-0.5">
                            {session.user?.name?.split(' ')[0]}
                        </span>
                        {isGuest && (
                            <span className="text-[8px] font-black text-primary uppercase tracking-tighter">Guest Mode</span>
                        )}
                    </div>
                </div>

                <button
                    onClick={() => signOut()}
                    className="p-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 text-gray-400 hover:text-white transition-all shadow-xl group"
                    title="Sign Out"
                >
                    <LogOut className="w-4 h-4 group-hover:scale-110 transition-transform" />
                </button>
            </div>
        );
    }

    return (
        <Button
            variant="secondary"
            size="sm"
            onClick={() => router.push('/auth/signin')}
            className="gap-2 bg-white/5 hover:bg-white/10 border-white/10 text-[11px] font-black uppercase tracking-widest py-2 px-5 rounded-xl"
        >
            <LogIn className="w-3.5 h-3.5" />
            <span>Sign In</span>
        </Button>
    );
}
