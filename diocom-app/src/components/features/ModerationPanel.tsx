'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert, CheckCircle, Ban, Eye, X, AlertTriangle, RefreshCw } from 'lucide-react';
import { formatTimestamp } from '@/lib/utils';

interface AbuseReportItem {
  id: string;
  share_id: string;
  reporter_email?: string | null;
  reason: string;
  details?: string | null;
  status: 'pending' | 'resolved' | 'dismissed';
  ip_address?: string | null;
  created_at: number;
}

export default function ModerationPanel() {
  const [reports, setReports] = useState<AbuseReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'resolved'>('pending');
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ id: string; msg: string; ok: boolean } | null>(null);

  const fetchReports = async () => {
    try {
      const url = filter === 'all' ? '/api/admin/moderation' : `/api/admin/moderation?status=${filter}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.reports) setReports(data.reports);
    } catch {} finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
    const interval = setInterval(fetchReports, 10000);
    return () => clearInterval(interval);
  }, [filter]);

  const handleAction = async (reportId: string, action: 'disable_file' | 'dismiss' | 'ban_user') => {
    setActionBusy(reportId);
    setFeedback(null);

    try {
      const res = await fetch('/api/admin/moderation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId, action }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Action failed');

      setFeedback({ id: reportId, msg: data.message || 'Success', ok: true });
      fetchReports();
    } catch (err) {
      setFeedback({ id: reportId, msg: err instanceof Error ? err.message : 'Error', ok: false });
    } finally {
      setActionBusy(null);
    }
  };

  const pendingCount = reports.filter((r) => r.status === 'pending').length;

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-sm shadow-[0_0_50px_rgba(239,68,68,0.04)]">
      {/* Header */}
      <div className="px-6 py-4 border-b border-red-500/20 bg-red-500/5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-red-500/20 border border-red-500/40 flex items-center justify-center text-red-400">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
              Abuse &amp; Content Moderation Queue
              {pendingCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500 text-slate-950 animate-pulse">
                  {pendingCount} Pending
                </span>
              )}
            </h3>
            <p className="text-[11px] text-gray-400">Review user-flagged links, DMCA takedowns, and malware reports</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-black/40 border border-white/10 p-0.5 text-xs">
            <button
              onClick={() => setFilter('pending')}
              className={`px-3 py-1 rounded-md font-semibold transition-colors ${
                filter === 'pending' ? 'bg-red-500 text-slate-950' : 'text-gray-400 hover:text-white'
              }`}
            >
              Pending
            </button>
            <button
              onClick={() => setFilter('resolved')}
              className={`px-3 py-1 rounded-md font-semibold transition-colors ${
                filter === 'resolved' ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              Resolved
            </button>
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1 rounded-md font-semibold transition-colors ${
                filter === 'all' ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              All
            </button>
          </div>
          <button
            onClick={() => fetchReports()}
            className="p-1.5 rounded-lg border border-white/10 text-gray-400 hover:text-white hover:bg-white/5"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Reports Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="uppercase tracking-wider border-b border-white/5 bg-white/5 font-bold text-[10px] text-gray-400">
            <tr>
              <th scope="col" className="px-6 py-3">Timestamp</th>
              <th scope="col" className="px-6 py-3">File Link</th>
              <th scope="col" className="px-6 py-3">Reason</th>
              <th scope="col" className="px-6 py-3">Reporter</th>
              <th scope="col" className="px-6 py-3">Details</th>
              <th scope="col" className="px-6 py-3">Status</th>
              <th scope="col" className="px-6 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 text-gray-300 font-mono text-[11px]">
            {reports.map((report) => (
              <tr key={report.id} className="hover:bg-white/5 transition-colors">
                <td className="px-6 py-4 opacity-60">
                  {formatTimestamp(new Date(report.created_at))}
                </td>
                <td className="px-6 py-4">
                  <a
                    href={`/v1/${report.share_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-cyan-400 hover:underline font-bold flex items-center gap-1"
                  >
                    {report.share_id.slice(0, 12)}...
                    <Eye className="w-3 h-3 opacity-60" />
                  </a>
                </td>
                <td className="px-6 py-4">
                  <span
                    className={`px-2 py-0.5 rounded text-[9px] uppercase font-bold border ${
                      report.reason === 'malware'
                        ? 'border-red-500/30 text-red-400 bg-red-500/10'
                        : report.reason === 'dmca'
                        ? 'border-yellow-500/30 text-yellow-400 bg-yellow-500/10'
                        : report.reason === 'illegal'
                        ? 'border-purple-500/30 text-purple-400 bg-purple-500/10'
                        : 'border-blue-500/30 text-blue-400 bg-blue-500/10'
                    }`}
                  >
                    {report.reason}
                  </span>
                </td>
                <td className="px-6 py-4 opacity-75 max-w-[140px] truncate" title={report.reporter_email || ''}>
                  {report.reporter_email || 'Anonymous'}
                </td>
                <td className="px-6 py-4 text-gray-400 max-w-[200px] truncate" title={report.details || ''}>
                  {report.details || 'No additional comments'}
                </td>
                <td className="px-6 py-4">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[8px] uppercase font-bold ${
                      report.status === 'pending'
                        ? 'bg-amber-500/20 text-amber-400'
                        : report.status === 'resolved'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-gray-500/20 text-gray-400'
                    }`}
                  >
                    {report.status}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  {feedback?.id === report.id ? (
                    <span className={`text-[10px] ${feedback.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                      {feedback.msg}
                    </span>
                  ) : report.status === 'pending' ? (
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        onClick={() => handleAction(report.id, 'disable_file')}
                        disabled={actionBusy === report.id}
                        className="px-2.5 py-1 rounded bg-red-500 hover:bg-red-400 text-slate-950 font-bold text-[10px] transition-colors"
                      >
                        Disable File
                      </button>
                      <button
                        onClick={() => handleAction(report.id, 'ban_user')}
                        disabled={actionBusy === report.id}
                        className="px-2.5 py-1 rounded bg-red-950 hover:bg-red-900 border border-red-500/40 text-red-300 font-bold text-[10px] transition-colors"
                      >
                        Ban User
                      </button>
                      <button
                        onClick={() => handleAction(report.id, 'dismiss')}
                        disabled={actionBusy === report.id}
                        className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white text-[10px] transition-colors"
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : (
                    <span className="text-gray-500 text-[10px]">Closed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {reports.length === 0 && !loading && (
          <div className="p-10 text-center text-gray-500 text-xs font-mono">
            No abuse reports in this view. All clear.
          </div>
        )}
      </div>
    </div>
  );
}
