'use client';

import { signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import Image from 'next/image';
import { LogIn, LogOut, User, LayoutGrid, Shield } from 'lucide-react';
import { buttonClasses } from '@/components/ui/Button';

export default function AuthStatus() {
    const { data: session, status } = useSession();

    if (status === 'loading') {
        return <div className="skeleton h-10 w-24 rounded-xl" aria-hidden="true" />;
    }

    if (session) {
        const isAdmin = (session.user as { role?: string } | undefined)?.role === 'admin';
        const name = session.user?.name?.split(' ')[0] || session.user?.email || 'Account';
        return (
            <div className="flex items-center gap-1 sm:gap-2">
                <Link
                    href="/dashboard"
                    aria-label="My transfers"
                    className="flex h-10 items-center gap-1.5 rounded-xl px-2.5 text-sm font-medium text-gray-300 transition-colors hover:bg-white/5 hover:text-white sm:px-3"
                >
                    <LayoutGrid className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden lg:inline">My transfers</span>
                </Link>

                {isAdmin && (
                    <Link
                        href="/admin"
                        aria-label="Admin"
                        className="flex h-10 items-center gap-1.5 rounded-xl px-2.5 text-sm font-medium text-red-300 transition-colors hover:bg-white/5 sm:px-3"
                    >
                        <Shield className="h-4 w-4" aria-hidden="true" />
                        <span className="hidden lg:inline">Admin</span>
                    </Link>
                )}

                <span className="hidden items-center gap-2 pl-1 sm:flex" title={session.user?.email ?? undefined}>
                    {session.user?.image ? (
                        <Image
                            src={session.user.image}
                            alt=""
                            width={32}
                            height={32}
                            unoptimized
                            className="h-8 w-8 rounded-full border border-white/10"
                        />
                    ) : (
                        <span className="grid h-8 w-8 place-items-center rounded-full border border-white/10 bg-white/5">
                            <User className="h-4 w-4 text-gray-300" aria-hidden="true" />
                        </span>
                    )}
                    <span className="hidden max-w-[10rem] truncate text-sm font-medium text-white xl:inline">{name}</span>
                </span>

                <button
                    type="button"
                    onClick={() => signOut()}
                    aria-label="Sign out"
                    title="Sign out"
                    className="grid h-10 w-10 place-items-center rounded-xl text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
                >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                </button>
            </div>
        );
    }

    return (
        <Link href="/auth/signin" className={buttonClasses('secondary', 'sm', 'h-10')}>
            <LogIn className="h-4 w-4" aria-hidden="true" />
            <span>Sign in</span>
        </Link>
    );
}
