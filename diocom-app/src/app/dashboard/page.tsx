import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth/options';
import { FileRepository } from '@/db/files';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import { FileType, Inbox, Palette, Key } from 'lucide-react';
import { formatFileSize, formatTimestamp } from '@/lib/utils';
import Link from 'next/link';
import Image from 'next/image';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import { buttonClasses } from '@/components/ui/Button';

import SearchInput from '@/components/features/SearchInput';
import DashboardFileCard from '@/components/features/DashboardFileCard';

export default async function DashboardPage({
    searchParams,
}: {
    searchParams: Promise<{ q?: string }>;
}) {
    const session = await getServerSession(authOptions);
    const params = await searchParams; // Await params in Next.js 15+

    if (!session?.user?.email) {
        redirect('/api/auth/signin');
    }

    const query = params?.q || '';

    // Fetch user files from DB (Search or List)
    const userFiles = query
        ? await FileRepository.searchFiles(session.user.id || '', query)
        : await FileRepository.findByUserId(session.user.id || '');

    return (
        <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
            <Header />

            <main id="main" className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8">
                {/* Navigation Tabs */}
                <div className="flex border-b border-white/10 gap-6 text-sm font-medium">
                    <Link
                        href="/dashboard"
                        className="pb-3 text-primary border-b-2 border-primary flex items-center gap-2 font-semibold"
                    >
                        My Transfers (Sent)
                    </Link>
                    <Link
                        href="/dashboard/requests"
                        className="pb-3 text-gray-400 hover:text-white transition-colors flex items-center gap-2"
                    >
                        <Inbox className="w-4 h-4" />
                        File Requests (Received)
                    </Link>
                    <Link
                        href="/dashboard/branding"
                        className="pb-3 text-gray-400 hover:text-white transition-colors flex items-center gap-2"
                    >
                        <Palette className="w-4 h-4" />
                        Branding &amp; Domain (Pro)
                    </Link>
                    <Link
                        href="/dashboard/api-keys"
                        className="pb-3 text-gray-400 hover:text-white transition-colors flex items-center gap-2"
                    >
                        <Key className="w-4 h-4" />
                        Developer API Keys
                    </Link>
                </div>

                <div className="flex flex-col sm:flex-row items-baseline justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-white">
                            My transfers
                        </h1>
                        <p className="mt-1 text-sm text-gray-300">
                            Files you&apos;ve shared while signed in.
                        </p>
                    </div>

                    <p className="panel px-4 py-2.5 text-sm text-gray-300">
                        <span className="text-lg font-semibold text-white">{userFiles.length}</span> file{userFiles.length === 1 ? '' : 's'}
                    </p>
                </div>

                <div className="flex flex-col md:flex-row gap-6 items-center">
                    {/* Collections */}
                    <nav aria-label="Filter by category" className="flex gap-2 overflow-x-auto pb-1 scrollbar-hidden flex-1 w-full">
                        {['All', 'Code', 'Visual', 'Media', 'Docs'].map((filter) => {
                            const isActive = filter === 'All' ? !query : query.toLowerCase() === filter.toLowerCase();
                            return (
                                <Link
                                    key={filter}
                                    href={filter === 'All' ? '/dashboard' : `/dashboard?q=${filter}`}
                                    aria-current={isActive ? 'page' : undefined}
                                    className={`h-10 inline-flex items-center px-4 rounded-xl text-sm font-medium transition-colors border whitespace-nowrap ${isActive
                                        ? 'bg-primary text-on-primary border-primary'
                                        : 'bg-white/5 text-gray-300 border-white/10 hover:bg-white/10 hover:text-white'
                                        }`}
                                >
                                    {filter}
                                </Link>
                            );
                        })}
                    </nav>

                    <div className="w-full md:w-80">
                        <SearchInput />
                    </div>
                </div>

                {userFiles.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center p-12 transition-all">
                        <div className="w-24 h-24 rounded-3xl bg-white/5 border border-white/10 flex items-center justify-center mb-8 relative group overflow-hidden">
                            <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                            <FileType className="w-10 h-10 text-gray-400 group-hover:text-primary transition-colors" aria-hidden="true" />
                        </div>
                        <h3 className="text-2xl font-bold mb-3 text-white">
                            {query ? `Nothing found for "${query}"` : 'Your history is clear'}
                        </h3>
                        <p className="text-gray-400 max-w-sm text-center mb-10 leading-relaxed">
                            {query ? 'Try searching for a different name or category.' : 'Files you upload while signed in show up here with their links and download counts.'}
                        </p>
                        <Link
                            href="/"
                            className={buttonClasses('primary', 'lg')}
                        >
                            {query ? 'Reset search' : 'Send a file'}
                        </Link>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {userFiles.map((file) => (
                            <DashboardFileCard
                                key={file.id}
                                file={file}
                                tag={firstTag(file.tags)}
                            />
                        ))}
                    </div>
                )}
            </main>

            <Footer />
        </div>
    );
}

function firstTag(tags: unknown): string | null {
    try {
        const arr = typeof tags === 'string' ? JSON.parse(tags) : tags;
        return Array.isArray(arr) && typeof arr[0] === 'string' ? arr[0] : null;
    } catch {
        return null;
    }
}
