import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '../api/auth/[...nextauth]/route';
import { FileRepository } from '@/db/files';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import { FileType } from 'lucide-react';
import { formatFileSize, formatTimestamp } from '@/lib/utils';
import Link from 'next/link';
import Image from 'next/image';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import { buttonClasses } from '@/components/ui/Button';

import SearchInput from '@/components/features/SearchInput';

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
                            <Link
                                key={file.id}
                                href={`/v1/${file.share_id}`}
                                className="group panel relative p-5 flex flex-col gap-4 transition-colors hover:border-primary/40"
                            >
                                <div className="flex items-center gap-4">
                                    <div className="w-14 h-14 rounded-xl bg-black/40 border border-white/10 overflow-hidden flex-shrink-0 relative">
                                        {file.thumbnail_path ? (
                                            <Image
                                                src={`/api/thumbnail/${file.share_id}`}
                                                alt=""
                                                fill
                                                sizes="56px"
                                                unoptimized
                                                className="object-cover"
                                            />
                                        ) : (
                                            <FileTypeIcon name={file.original_name} className="h-full w-full rounded-none border-0" />
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h2 className="font-semibold text-white group-hover:text-primary transition-colors truncate" title={file.original_name}>
                                            {file.original_name}
                                        </h2>
                                        <div className="flex items-center gap-2 mt-1.5">
                                            <span className="text-xs text-gray-300">
                                                {formatFileSize(file.file_size)}
                                            </span>
                                            {firstTag(file.tags) && (
                                                <span className="text-xs text-primary">
                                                    #{firstTag(file.tags)}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {file.summary && (
                                    <p className="text-sm text-gray-300 line-clamp-2 leading-relaxed">
                                        {file.summary}
                                    </p>
                                )}

                                <div className="flex items-center justify-between text-xs mt-auto pt-4 border-t border-white/[0.06]">
                                    <div className="flex flex-col gap-0.5">
                                        <span className="text-gray-400">Uploaded</span>
                                        <span className="text-gray-200">{formatTimestamp(new Date(file.created_at))}</span>
                                    </div>
                                    <div className="flex flex-col gap-0.5 text-right">
                                        <span className="text-gray-400">Downloads</span>
                                        <span className="text-gray-200">{file.downloads}</span>
                                    </div>
                                </div>
                            </Link>
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
