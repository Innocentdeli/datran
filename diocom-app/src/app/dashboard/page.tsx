import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '../api/auth/[...nextauth]/route';
import { FileRepository } from '@/db/files';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import { FileType } from 'lucide-react';
import { formatFileSize, formatTimestamp } from '@/lib/utils';
import { getFileIcon } from '@/lib/fileUtils';
import Link from 'next/link';

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
        <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center p-4 sm:p-8 font-sans selection:bg-primary/30">
            <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-gray-900/40 via-black to-black -z-10" />

            <Header />

            <main className="w-full max-w-7xl flex-1 flex flex-col gap-8">
                <div className="flex flex-col sm:flex-row items-baseline justify-between gap-4">
                    <div>
                        <h2 className="text-3xl font-bold tracking-tight text-white mb-1">
                            My Transfers
                        </h2>
                        <p className="text-xs text-gray-400 font-medium tracking-wide uppercase">
                            Manage your shared files and history
                        </p>
                    </div>

                    <div className="flex items-center gap-4 bg-white/5 border border-white/10 rounded-2xl px-4 py-3 backdrop-blur-md">
                        <div className="flex flex-col">
                            <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Total Items</span>
                            <span className="text-xl font-bold text-primary">{userFiles.length}</span>
                        </div>
                        <div className="w-px h-8 bg-white/10" />
                        <div className="flex flex-col">
                            <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">System Status</span>
                            <div className="flex items-center gap-1.5">
                                <div className="w-1.5 h-1.5 rounded-full bg-success shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                                <span className="text-xs font-bold text-gray-200 uppercase">Optimal</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex flex-col md:flex-row gap-6 items-center">
                    {/* Collections */}
                    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hidden flex-1">
                        {['All', 'Code', 'Visual', 'Media', 'Docs'].map((filter) => {
                            const isActive = filter === 'All' ? !query : query.toLowerCase() === filter.toLowerCase();
                            return (
                                <Link
                                    key={filter}
                                    href={filter === 'All' ? '/dashboard' : `/dashboard?q=${filter}`}
                                    className={`px-5 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all border whitespace-nowrap ${isActive
                                        ? 'bg-primary text-black border-primary shadow-[0_0_20px_rgba(0,242,255,0.3)]'
                                        : 'bg-white/5 text-gray-400 border-white/10 hover:bg-white/10 hover:text-white'
                                        }`}
                                >
                                    {filter}
                                </Link>
                            );
                        })}
                    </div>

                    <div className="w-full md:w-80">
                        <SearchInput />
                    </div>
                </div>

                {userFiles.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center p-12 transition-all">
                        <div className="w-24 h-24 rounded-3xl bg-white/5 border border-white/10 flex items-center justify-center mb-8 relative group overflow-hidden">
                            <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                            <FileType className="w-10 h-10 text-white/30 group-hover:text-primary transition-colors" />
                        </div>
                        <h3 className="text-2xl font-bold mb-3 text-white">
                            {query ? `Nothing found for "${query}"` : 'Your history is clear'}
                        </h3>
                        <p className="text-gray-400 max-w-sm text-center mb-10 leading-relaxed">
                            {query ? 'Try searching for a different name or category.' : 'Start sharing files to see them listed here. Datran keeps your transfers organized and secure.'}
                        </p>
                        <Link
                            href="/"
                            className="px-8 py-4 bg-white text-black font-black uppercase tracking-widest rounded-2xl hover:scale-105 transition-transform shadow-xl"
                        >
                            {query ? 'Reset Search' : 'Start Transfer'}
                        </Link>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {userFiles.map((file) => (
                            <Link
                                key={file.id}
                                href={`/v1/${file.share_id}`}
                                className="group relative bg-white/[0.03] border border-white/[0.08] hover:border-primary/40 hover:bg-white/[0.08] transition-all duration-500 rounded-[24px] p-6 flex flex-col gap-5 backdrop-blur-sm"
                            >
                                <div className="flex items-center gap-4">
                                    <div className="w-16 h-16 rounded-2xl bg-black/40 border border-white/10 overflow-hidden shadow-2xl flex-shrink-0 relative group-hover:scale-110 transition-transform duration-500">
                                        {file.thumbnail_path ? (
                                            <img
                                                src={`/api/thumbnail/${file.share_id}`}
                                                alt={file.original_name}
                                                className="w-full h-full object-cover"
                                                loading="lazy"
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center text-3xl">
                                                {getFileIcon((file.original_name.split('.').pop() || 'file') as any)}
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="font-bold text-white group-hover:text-primary transition-colors truncate text-lg" title={file.original_name}>
                                            {file.original_name}
                                        </h3>
                                        <div className="flex items-center gap-2 mt-1.5">
                                            <span className="text-[10px] font-bold text-gray-500 bg-white/5 border border-white/10 px-2 py-0.5 rounded-md uppercase tracking-widest">
                                                {formatFileSize(file.file_size)}
                                            </span>
                                            {file.tags && JSON.parse(file.tags).length > 0 && (
                                                <span className="text-[9px] font-bold text-primary opacity-60 uppercase tracking-widest">
                                                    #{JSON.parse(file.tags)[0]}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {file.summary && (
                                    <p className="text-sm text-gray-400 line-clamp-2 leading-relaxed font-medium">
                                        {file.summary}
                                    </p>
                                )}

                                <div className="flex items-center justify-between text-[11px] text-gray-500 font-bold uppercase tracking-widest mt-auto pt-5 border-t border-white/[0.05]">
                                    <div className="flex flex-col gap-0.5">
                                        <span className="text-[9px] opacity-40 font-medium">Uploaded</span>
                                        <span className="text-gray-400">{formatTimestamp(new Date(file.created_at))}</span>
                                    </div>
                                    <div className="flex flex-col gap-0.5 text-right">
                                        <span className="text-[9px] opacity-40 font-medium">Interactions</span>
                                        <span className="text-primary">{file.downloads} DL</span>
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
