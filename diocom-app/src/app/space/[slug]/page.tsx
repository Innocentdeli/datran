'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { motion } from 'framer-motion';
import { FolderOpen, Upload, Users, Download, Globe, Lock, FileText, Image as ImageIcon, Archive, Loader2, Link, CheckCircle, LogIn } from 'lucide-react';

interface SpaceFile {
  share_id: string;
  original_name: string;
  file_size: number;
  mime_type: string;
  uploader_name: string;
  uploaded_at: number;
}

interface Member {
  id: string;
  name: string;
  image: string;
  username: string;
  role: string;
}

interface Space {
  id: string;
  name: string;
  slug: string;
  description: string;
  is_public: number;
  owner_id: string;
}

function fileIcon(mime: string) {
  if (mime?.startsWith('image/')) return <ImageIcon size={14} className="text-blue-400" />;
  if (mime?.includes('zip')) return <Archive size={14} className="text-amber-400" />;
  return <FileText size={14} className="text-slate-400" />;
}

function formatBytes(b: number) {
  if (!b) return '—';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function SpacePage() {
  const params = useParams();
  const slug = params?.slug as string;

  const { data: session } = useSession();
  const router = useRouter();
  const isAuthenticated = !!session?.user;

  const [space, setSpace] = useState<Space | null>(null);
  const [files, setFiles] = useState<SpaceFile[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/spaces/${slug}`);
      if (!res.ok) {
        setErrorStatus(res.status);
        setLoading(false);
        return;
      }
      const data = await res.json();
      setSpace(data.space);
      setFiles(data.files);
      setMembers(data.members);
      setLoading(false);
    })();
  }, [slug]);

  const handleDrop = async (e: React.DragEvent) => {
    if (!isAuthenticated) return;
    e.preventDefault();
    // Uploading straight into a space is not implemented yet (files are added via POST /api/spaces/[slug]/files).
  };

  const copySpaceLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/space/${slug}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) return (
    <div className="min-h-screen bg-[#0A0F1A] flex items-center justify-center">
      <Loader2 size={32} className="text-violet-400 animate-spin" />
    </div>
  );

  if (errorStatus === 401 || errorStatus === 403) return (
    <div className="min-h-screen bg-[#0A0F1A] flex items-center justify-center p-6">
      <div className="max-w-md w-full glass bg-[#0d1424] border-white/5 rounded-[40px] p-8 text-center animate-fade-in-up">
        <div className="w-16 h-16 rounded-2xl bg-violet-500/10 flex items-center justify-center mx-auto mb-6 border border-violet-500/20 shadow-2xl">
          <Lock size={28} className="text-violet-400" />
        </div>
        <h2 className="text-xl font-bold text-white mb-2 italic uppercase tracking-tighter">Private Drop Zone</h2>
        <p className="text-slate-500 text-sm mb-8 leading-relaxed">
          This shared space is restricted to authorized team members. 
          Sign in to request access or view your own spaces.
        </p>
        <button
          onClick={() => router.push('/auth/signin')}
          className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-violet-500 hover:bg-violet-600 text-white font-bold transition-all shadow-lg active:scale-95"
        >
          <LogIn size={18} />
          Sign In to Access
        </button>
      </div>
    </div>
  );

  if (errorStatus === 404) return (
    <div className="min-h-screen bg-[#0A0F1A] flex items-center justify-center">
      <p className="text-slate-500 text-sm italic">Space not found.</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0A0F1A] text-white">
      {/* Background */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[40%] h-[40%] bg-violet-500/6 rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 max-w-5xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-violet-500/15 border border-violet-500/25 flex items-center justify-center">
              <FolderOpen size={26} className="text-violet-400" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <h1 className="text-2xl font-bold text-white">{space?.name}</h1>
                {space?.is_public ? (
                  <span className="flex items-center gap-1 text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                    <Globe size={10} /> Public
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-[10px] font-mono bg-slate-500/10 text-slate-500 border border-slate-700 px-2 py-0.5 rounded-full">
                    <Lock size={10} /> Private
                  </span>
                )}
              </div>
              {space?.description && <p className="text-sm text-slate-500">{space.description}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={copySpaceLink}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 transition-colors"
            >
              {copied ? <CheckCircle size={14} className="text-emerald-400" /> : <Link size={14} />}
              {copied ? 'Copied!' : 'Copy Link'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-6">
          {/* Main: Drop Zone + Files */}
          <div className="col-span-2 space-y-5">
            {/* Drop Zone */}
            <motion.div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              animate={{ borderColor: isDragging ? 'rgba(139, 92, 246, 0.6)' : 'rgba(255,255,255,0.08)' }}
              className="relative rounded-2xl border-2 border-dashed bg-white/2 transition-colors"
            >
              <div className="flex flex-col items-center justify-center py-10 gap-2 pointer-events-none">
                <Upload size={28} className={isDragging ? 'text-violet-400' : 'text-slate-600'} />
                <p className="text-sm text-slate-500">
                  {isDragging ? 'Drop to add to space' : 'Drag & drop files here to share with the space'}
                </p>
              </div>
            </motion.div>

            {/* Files List */}
            <div className="bg-[#0d1424] border border-white/8 rounded-2xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/6">
                <h2 className="text-sm font-semibold text-white">Files ({files.length})</h2>
              </div>
              {files.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-600">
                  <FolderOpen size={32} className="mb-2 opacity-40" />
                  <p className="text-sm">No files yet. Drop some above!</p>
                </div>
              ) : (
                <div className="divide-y divide-white/4">
                  {files.map((f) => (
                    <motion.div
                      key={f.share_id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-center gap-4 px-5 py-4 hover:bg-white/3 group transition-colors"
                    >
                      <div className="w-8 h-8 rounded-xl bg-white/4 flex items-center justify-center shrink-0">
                        {fileIcon(f.mime_type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white font-medium truncate">{f.original_name}</p>
                        <p className="text-xs text-slate-600">{formatBytes(f.file_size)} · by {f.uploader_name} · {formatDate(f.uploaded_at)}</p>
                      </div>
                      <a
                        href={`/v1/${f.share_id}`}
                        target="_blank"
                        className="opacity-0 group-hover:opacity-100 p-2 rounded-xl bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 transition-all"
                      >
                        <Download size={14} />
                      </a>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Sidebar: Members */}
          <div className="space-y-5">
            <div className="bg-[#0d1424] border border-white/8 rounded-2xl overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-4 border-b border-white/6">
                <Users size={14} className="text-slate-500" />
                <h2 className="text-sm font-semibold text-white">Members ({members.length})</h2>
              </div>
              <div className="p-3 space-y-1">
                {members.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/4 transition-colors">
                    {m.image ? (
                      // OAuth avatar from an arbitrary provider host: next/image would need every host in remotePatterns.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.image} className="w-7 h-7 rounded-full object-cover" alt="" />
                    ) : (
                      <div className="w-7 h-7 rounded-full bg-violet-500/25 flex items-center justify-center text-violet-400 text-[11px] font-bold">
                        {m.name?.[0]?.toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-white truncate">{m.name}</p>
                      {m.username && <p className="text-[10px] text-slate-600">@{m.username}</p>}
                    </div>
                    {m.role === 'owner' && (
                      <span className="text-[9px] font-mono bg-amber-500/10 text-amber-500 px-1.5 py-0.5 rounded">OWNER</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
