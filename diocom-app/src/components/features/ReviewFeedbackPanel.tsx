'use client';

import { useState, useEffect } from 'react';
import Button from '@/components/ui/Button';
import {
  CheckCircle2,
  AlertCircle,
  MessageSquare,
  Clock,
  Send,
  User,
  Mail,
  Loader2,
  X,
  Play,
  Check,
  ChevronDown,
  ChevronUp,
  MapPin,
  Sparkles
} from 'lucide-react';
import { formatDurationShort } from '@/lib/utils';

interface FileReview {
  id: string;
  reviewer_name: string;
  reviewer_email: string | null;
  status: 'pending' | 'approved' | 'changes_requested';
  decision_note: string | null;
  created_at: number;
  updated_at: number;
}

interface FileReviewComment {
  id: string;
  author_name: string;
  author_email: string | null;
  comment: string;
  timestamp_seconds: number | null;
  coord_x: number | null;
  coord_y: number | null;
  resolved: number;
  created_at: number;
}

interface ReviewFeedbackPanelProps {
  fileId: string;
  fileName: string;
  fileType: string;
}

function formatMediaTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default function ReviewFeedbackPanel({ fileId, fileName, fileType }: ReviewFeedbackPanelProps) {
  const [reviews, setReviews] = useState<FileReview[]>([]);
  const [comments, setComments] = useState<FileReviewComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCommentsOpen, setIsCommentsOpen] = useState(false);

  // Review Modal State
  const [showReviewModal, setShowReviewModal] = useState<null | 'approved' | 'changes_requested'>(null);
  const [reviewerName, setReviewerName] = useState('');
  const [reviewerEmail, setReviewerEmail] = useState('');
  const [decisionNote, setDecisionNote] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // New Comment State
  const [commentText, setCommentText] = useState('');
  const [commentAuthor, setCommentAuthor] = useState('');
  const [commentEmail, setCommentEmail] = useState('');
  const [attachTimestamp, setAttachTimestamp] = useState<number | null>(null);
  const [submittingComment, setSubmittingComment] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);

  const fetchFeedback = async () => {
    try {
      const res = await fetch(`/api/transfers/${fileId}/reviews`);
      const data = await res.json();
      if (data.success) {
        setReviews(data.reviews || []);
        setComments(data.comments || []);
      }
    } catch (err) {
      console.error('Failed to load review feedback:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFeedback();
    if (typeof window !== 'undefined') {
      const cachedName = localStorage.getItem('datran_reviewer_name');
      const cachedEmail = localStorage.getItem('datran_reviewer_email');
      if (cachedName) {
        setReviewerName(cachedName);
        setCommentAuthor(cachedName);
      }
      if (cachedEmail) {
        setReviewerEmail(cachedEmail);
        setCommentEmail(cachedEmail);
      }
    }
  }, [fileId]);

  const handleCaptureTimestamp = () => {
    if (typeof window !== 'undefined') {
      const currentTime = (window as unknown as { __DATRAN_CURRENT_MEDIA_TIME?: number }).__DATRAN_CURRENT_MEDIA_TIME;
      if (currentTime != null) {
        setAttachTimestamp(Math.round(currentTime * 10) / 10);
      } else {
        setAttachTimestamp(0);
      }
    }
  };

  const handleSeek = (seconds: number) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('datran:seek-media', { detail: { time: seconds } }));
    }
  };

  const handleReviewSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!showReviewModal) return;
    setReviewError(null);
    setSubmittingReview(true);

    try {
      const res = await fetch(`/api/transfers/${fileId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewerName,
          reviewerEmail,
          status: showReviewModal,
          decisionNote,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit review');

      if (typeof window !== 'undefined') {
        localStorage.setItem('datran_reviewer_name', reviewerName);
        if (reviewerEmail) localStorage.setItem('datran_reviewer_email', reviewerEmail);
      }

      setShowReviewModal(null);
      setDecisionNote('');
      await fetchFeedback();
    } catch (err) {
      setReviewError((err as Error)?.message || 'An error occurred');
    } finally {
      setSubmittingReview(false);
    }
  };

  const handleCommentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim() || !commentAuthor.trim()) return;
    setCommentError(null);
    setSubmittingComment(true);

    try {
      const res = await fetch(`/api/transfers/${fileId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorName: commentAuthor,
          authorEmail: commentEmail,
          comment: commentText,
          timestampSeconds: attachTimestamp,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to post comment');

      if (typeof window !== 'undefined') {
        localStorage.setItem('datran_reviewer_name', commentAuthor);
        if (commentEmail) localStorage.setItem('datran_reviewer_email', commentEmail);
      }

      setCommentText('');
      setAttachTimestamp(null);
      await fetchFeedback();
    } catch (err) {
      setCommentError((err as Error)?.message || 'An error occurred');
    } finally {
      setSubmittingComment(false);
    }
  };

  const handleToggleResolve = async (commentId: string, currentResolved: number) => {
    try {
      await fetch(`/api/transfers/${fileId}/comments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commentId,
          resolved: currentResolved === 0,
        }),
      });
      await fetchFeedback();
    } catch (err) {
      console.error('Failed to toggle comment resolution:', err);
    }
  };

  // Determine latest review consensus
  const latestReview = reviews[0];
  const isApproved = latestReview?.status === 'approved';
  const isChangesRequested = latestReview?.status === 'changes_requested';

  return (
    <div className="border border-white/10 rounded-2xl bg-white/[0.02] p-4 sm:p-5 space-y-4">
      {/* Top Review Control Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-primary shrink-0">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white tracking-tight">Review &amp; Approval</h2>
              {isApproved && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Approved
                </span>
              )}
              {isChangesRequested && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-300">
                  <AlertCircle className="w-3.5 h-3.5" /> Changes Requested
                </span>
              )}
              {!latestReview && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-white/5 text-gray-400 border border-white/10">
                  Pending Review
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {latestReview
                ? `Reviewed by ${latestReview.reviewer_name} • ${new Date(latestReview.updated_at).toLocaleDateString()}`
                : 'Leave feedback or mark deliverable status'}
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button
            type="button"
            onClick={() => setShowReviewModal('approved')}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 transition-colors"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Approve
          </button>

          <button
            type="button"
            onClick={() => setShowReviewModal('changes_requested')}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 transition-colors"
          >
            <AlertCircle className="w-3.5 h-3.5" /> Request Changes
          </button>

          <button
            type="button"
            onClick={() => setIsCommentsOpen(!isCommentsOpen)}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-white/5 border border-white/10 text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
          >
            <MessageSquare className="w-3.5 h-3.5 text-sky-400" />
            <span>Comments ({comments.length})</span>
            {isCommentsOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Decision Note if latest review has one */}
      {latestReview?.decision_note && (
        <div className="rounded-xl bg-white/[0.03] border border-white/10 p-3 text-xs text-gray-300 space-y-1">
          <span className="font-semibold text-white">Reviewer Note:</span>
          <p className="italic text-gray-300">&quot;{latestReview.decision_note}&quot;</p>
        </div>
      )}

      {/* Comments Drawer / Thread */}
      {isCommentsOpen && (
        <div className="border-t border-white/10 pt-4 space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Discussion &amp; Annotations
          </h3>

          {/* Comment List */}
          {comments.length === 0 ? (
            <p className="text-xs text-gray-500 italic py-2">
              No comments yet. Leave the first note or timestamped comment below.
            </p>
          ) : (
            <ul className="space-y-3">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className={`p-3 rounded-xl border transition-colors ${
                    c.resolved ? 'bg-white/[0.01] border-white/5 opacity-60' : 'bg-white/[0.03] border-white/10'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">{c.author_name}</span>
                      {c.timestamp_seconds != null && (
                        <button
                          type="button"
                          onClick={() => handleSeek(c.timestamp_seconds!)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono font-bold bg-sky-500/15 border border-sky-500/30 text-sky-300 hover:bg-sky-500/25 transition-colors"
                          title="Click to jump video to this timestamp"
                        >
                          <Play className="w-2.5 h-2.5 fill-current" /> {formatMediaTime(c.timestamp_seconds)}
                        </button>
                      )}
                      {c.coord_x != null && c.coord_y != null && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-purple-500/15 border border-purple-500/30 text-purple-300">
                          <MapPin className="w-2.5 h-2.5" /> Pin ({Math.round(c.coord_x)}%, {Math.round(c.coord_y)}%)
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-gray-500">
                        {new Date(c.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleToggleResolve(c.id, c.resolved)}
                        className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                          c.resolved
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            : 'bg-white/5 text-gray-400 border-white/10 hover:text-white'
                        }`}
                      >
                        {c.resolved ? '✓ Resolved' : 'Resolve'}
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">{c.comment}</p>
                </li>
              ))}
            </ul>
          )}

          {/* Comment Form */}
          <form onSubmit={handleCommentSubmit} className="space-y-3 pt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                required
                placeholder="Your Name (e.g. Sarah / Client)"
                value={commentAuthor}
                onChange={(e) => setCommentAuthor(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder:text-gray-500 focus:outline-none focus:border-primary/60"
              />
              <input
                type="email"
                placeholder="Your Email (optional)"
                value={commentEmail}
                onChange={(e) => setCommentEmail(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder:text-gray-500 focus:outline-none focus:border-primary/60"
              />
            </div>

            <textarea
              required
              rows={2}
              placeholder="Leave feedback, revisions, or approval notes..."
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-xs text-white placeholder:text-gray-500 focus:outline-none focus:border-primary/60 resize-none"
            />

            <div className="flex items-center justify-between">
              {fileType === 'video' || fileType === 'audio' ? (
                <button
                  type="button"
                  onClick={handleCaptureTimestamp}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono transition-colors border ${
                    attachTimestamp != null
                      ? 'bg-sky-500/20 border-sky-500/40 text-sky-200'
                      : 'bg-white/5 border-white/10 text-gray-400 hover:text-white'
                  }`}
                >
                  <Clock className="w-3.5 h-3.5" />
                  {attachTimestamp != null ? `Pinned to ${formatMediaTime(attachTimestamp)}` : 'Pin to Current Frame'}
                </button>
              ) : <div />}

              <Button type="submit" variant="primary" size="sm" disabled={submittingComment || !commentText.trim()}>
                {submittingComment ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Send className="w-3.5 h-3.5 mr-1.5" />}
                Post Comment
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Review Decision Modal */}
      {showReviewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
          <div className="panel w-full max-w-md border border-white/10 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                {showReviewModal === 'approved' ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    Approve Deliverable
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-5 h-5 text-amber-400" />
                    Request Changes
                  </>
                )}
              </h3>
              <button onClick={() => setShowReviewModal(null)} className="text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-gray-300">
              {showReviewModal === 'approved'
                ? `Notify the sender that "${fileName}" is approved and ready for sign-off.`
                : `Notify the sender that "${fileName}" requires revisions.`}
            </p>

            <form onSubmit={handleReviewSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
                  Your Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. John Doe / Client"
                  value={reviewerName}
                  onChange={(e) => setReviewerName(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/60"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
                  Your Email
                </label>
                <input
                  type="email"
                  placeholder="john@company.com"
                  value={reviewerEmail}
                  onChange={(e) => setReviewerEmail(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/60"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
                  Note / Summary
                </label>
                <textarea
                  rows={3}
                  placeholder={
                    showReviewModal === 'approved'
                      ? 'e.g. Looks great, fully approved for publishing!'
                      : 'e.g. Please update the soundtrack and adjust color grading.'
                  }
                  value={decisionNote}
                  onChange={(e) => setDecisionNote(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-xs text-white placeholder:text-gray-500 focus:outline-none focus:border-primary/60 resize-none"
                />
              </div>

              {reviewError && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-200">
                  {reviewError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowReviewModal(null)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={showReviewModal === 'approved' ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={submittingReview || !reviewerName.trim()}
                >
                  {submittingReview ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                  Confirm {showReviewModal === 'approved' ? 'Approval' : 'Change Request'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
