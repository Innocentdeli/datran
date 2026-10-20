'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { FolderOpen, Plus, Globe, Lock, FolderPlus, Loader2, X, ArrowRight, LogIn } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';

interface Space {
  id: string; name: string; slug: string;
  description: string; is_public: number; created_at: number;
}

interface SpacesResponse {
  owned?: Space[];
  member?: Space[];
}

async function fetchSpaces(): Promise<SpacesResponse | null> {
  const res = await fetch('/api/spaces');
  if (!res.ok) return null;
  return res.json();
}

export default function SpacesDashboard() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const isAuthenticated = !!session?.user;

  const [owned, setOwned] = useState<Space[]>([]);
  const [member, setMember] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', isPublic: false });
  const [submitting, setSubmitting] = useState(false);

  // Only meaningful while signed in; until the session resolves (or when signed out) the list isn't fetched.
  const showLoading = status === 'loading' || (isAuthenticated && loading);

  const applySpaces = (data: SpacesResponse | null) => {
    if (!data) return;
    setOwned(data.owned || []);
    setMember(data.member || []);
    setLoading(false);
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchSpaces().then(applySpaces);
  }, [isAuthenticated]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const res = await fetch('/api/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    });
    if (res.ok) {
      setCreating(false);
      setForm({ name: '', description: '', isPublic: false });
      fetchSpaces().then(applySpaces);
    }
    setSubmitting(false);
  };

  const SpaceCard = ({ space }: { space: Space }) => (
    <Link href={`/space/${space.slug}`}>
      <motion.div
        whileHover={{ y: -2 }}
        className="p-5 bg-[#0d1424] border border-white/8 rounded-2xl hover:border-violet-500/30 transition-all cursor-pointer group"
      >
        <div className="flex items-start justify-between mb-3">
          <div className="w-10 h-10 rounded-xl bg-violet-500/12 flex items-center justify-center">
            <FolderOpen size={18} className="text-violet-400" />
          </div>
          {space.is_public ? (
            <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-400 bg-emerald-500/8 border border-emerald-500/15 px-2 py-0.5 rounded-full">
              <Globe size={9} /> Public
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[10px] font-mono text-slate-600 bg-slate-800/60 border border-slate-700/60 px-2 py-0.5 rounded-full">
              <Lock size={9} /> Private
            </span>
          )}
        </div>
        <h3 className="text-sm font-semibold text-white mb-1 group-hover:text-violet-300 transition-colors">{space.name}</h3>
        {space.description && (
          <p className="text-xs text-slate-600 line-clamp-1">{space.description}</p>
        )}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/5">
          <span className="text-[10px] text-slate-600">
            {new Date(space.created_at).toLocaleDateString()}
          </span>
          <ArrowRight size={12} className="text-slate-700 group-hover:text-violet-500 transition-colors" />
        </div>
      </motion.div>
    </Link>
  );

  return (
    <div className="min-h-screen bg-[#0A0F1A] text-white">
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute top-0 right-1/4 w-[40%] h-[40%] bg-violet-500/6 rounded-full blur-[120px]" />
      </div>
      <div className="relative z-10 max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white mb-1">Drop Zones</h1>
            <p className="text-sm text-slate-500">Shared spaces for teams and groups</p>
          </div>
          {isAuthenticated && (
            <button
              onClick={() => setCreating(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-violet-500 hover:bg-violet-600 text-white text-sm font-semibold transition-colors"
            >
              <Plus size={16} />
              New Space
            </button>
          )}
        </div>

        {showLoading ? (
          <div className="flex justify-center py-20"><Loader2 size={28} className="text-violet-400 animate-spin" /></div>
        ) : !isAuthenticated ? (
          <div className="flex flex-col items-center justify-center py-24 text-center glass bg-[#0d1424] border-white/5 rounded-[40px] px-8">
            <div className="w-20 h-20 rounded-3xl bg-violet-500/10 flex items-center justify-center mb-8 border border-violet-500/20 shadow-2xl">
              <Lock size={32} className="text-violet-400" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-4 italic uppercase tracking-tighter">Premium Shared Spaces</h2>
            <p className="text-slate-400 max-w-md mx-auto mb-10 text-sm leading-relaxed">
              Drop Zones allow teams to collaborate in persistent, Zero-Knowledge shared buckets. 
              Sign in to create your own spaces or join private team zones.
            </p>
            <button
              onClick={() => router.push('/auth/signin')}
              className="flex items-center gap-3 px-8 py-3.5 rounded-2xl bg-violet-500 hover:bg-violet-600 text-white font-bold transition-all hover:scale-105 active:scale-95 shadow-[0_0_40px_rgba(139,92,246,0.3)]"
            >
              <LogIn size={20} />
              Sign In to Unlock
            </button>
          </div>
        ) : (
          <div className="space-y-8">
            {owned.length > 0 && (
              <section>
                <h2 className="text-xs font-mono text-slate-600 uppercase tracking-widest mb-3">My Spaces</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {owned.map(s => <SpaceCard key={s.id} space={s} />)}
                </div>
              </section>
            )}
            {member.length > 0 && (
              <section>
                <h2 className="text-xs font-mono text-slate-600 uppercase tracking-widest mb-3">Member Of</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {member.map(s => <SpaceCard key={s.id} space={s} />)}
                </div>
              </section>
            )}
            {owned.length === 0 && member.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-slate-600">
                <FolderPlus size={40} className="mb-4 opacity-40" />
                <p className="text-sm mb-2">No spaces yet</p>
                <button onClick={() => setCreating(true)} className="text-violet-400 text-sm hover:underline">Create your first space →</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Modal */}
      <AnimatePresence>
        {creating && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => setCreating(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm bg-[#0d1424] border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-white/8">
                <h3 className="text-sm font-bold text-white">Create New Space</h3>
                <button onClick={() => setCreating(false)} className="text-slate-600 hover:text-white transition-colors"><X size={16} /></button>
              </div>
              <form onSubmit={handleCreate} className="p-6 space-y-4">
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="Space name"
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-slate-600 outline-none focus:border-violet-500/40 transition-colors"
                />
                <textarea
                  value={form.description}
                  onChange={(e) => setForm(p => ({ ...p, description: e.target.value }))}
                  placeholder="Description (optional)"
                  rows={2}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-slate-600 outline-none resize-none focus:border-violet-500/40 transition-colors"
                />
                <label className="flex items-center gap-3 cursor-pointer group">
                  <div
                    onClick={() => setForm(p => ({ ...p, isPublic: !p.isPublic }))}
                    className={`w-10 h-6 rounded-full transition-colors ${form.isPublic ? 'bg-violet-500' : 'bg-slate-700'} relative`}
                  >
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${form.isPublic ? 'left-5' : 'left-1'}`} />
                  </div>
                  <span className="text-sm text-slate-400">Make public (anyone with link can view)</span>
                </label>
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-violet-500 hover:bg-violet-600 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
                >
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : <FolderPlus size={14} />}
                  Create Space
                </button>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
