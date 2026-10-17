'use client';

import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, Play, Pause, Volume2, VolumeX, Maximize, Loader2, Zap } from 'lucide-react';
import { cn, formatDuration } from '@/lib/utils';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';

import type { PublicFile } from '@/db/files';
import { useE2ESource } from '@/components/viewers/useE2ESource';

interface VideoPlayerProps {
    fileId: string;
    metadata?: PublicFile;
}

export default function VideoPlayer({ fileId, metadata }: VideoPlayerProps) {
    const title = metadata?.original_name || decodeURIComponent(fileId).replace(/\.(omni|reactor)\.acs$/, '');
    const [isReady, setIsReady] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [progress, setProgress] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [showControls, setShowControls] = useState(true);
    const { src: videoSrc, error: decryptError, download } = useE2ESource(fileId, metadata);
    const videoRef = useRef<HTMLVideoElement>(null);
    const controlsTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

    useEffect(() => {
        // Trigger Swarm Pre-fetch
        fetch('/api/prefetch', {
            method: 'POST',
            body: JSON.stringify({ fileId })
        }).catch(() => { });

        // Simulated precognition loading
        const interval = setInterval(() => {
            setProgress((prev) => {
                if (prev >= 100) {
                    setIsReady(true);
                    clearInterval(interval);
                    return 100;
                }
                return prev + 5;
            });
        }, 80);

        return () => {
            clearInterval(interval);
        };
    }, [fileId]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleTimeUpdate = () => {
            setCurrentTime(video.currentTime);
        };

        const handleLoadedMetadata = () => {
            setDuration(video.duration);
        };

        const handleEnded = () => {
            setIsPlaying(false);
        };

        video.addEventListener('timeupdate', handleTimeUpdate);
        video.addEventListener('loadedmetadata', handleLoadedMetadata);
        video.addEventListener('ended', handleEnded);

        return () => {
            video.removeEventListener('timeupdate', handleTimeUpdate);
            video.removeEventListener('loadedmetadata', handleLoadedMetadata);
            video.removeEventListener('ended', handleEnded);
        };
    }, [isReady, videoSrc]);

    const handlePlayPause = () => {
        if (!videoRef.current) return;

        if (isPlaying) {
            videoRef.current.pause();
        } else {
            videoRef.current.play();
        }
        setIsPlaying(!isPlaying);
    };

    const handleMuteToggle = () => {
        if (!videoRef.current) return;
        videoRef.current.muted = !isMuted;
        setIsMuted(!isMuted);
    };

    const handleFullscreen = () => {
        if (!videoRef.current) return;
        if (videoRef.current.requestFullscreen) {
            videoRef.current.requestFullscreen();
        }
    };

    const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!videoRef.current) return;
        const bounds = e.currentTarget.getBoundingClientRect();
        const percent = (e.clientX - bounds.left) / bounds.width;
        videoRef.current.currentTime = percent * duration;
    };

    const handleMouseMove = () => {
        setShowControls(true);
        if (controlsTimeoutRef.current) {
            clearTimeout(controlsTimeoutRef.current);
        }
        controlsTimeoutRef.current = setTimeout(() => {
            if (isPlaying) {
                setShowControls(false);
            }
        }, 3000);
    };

    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

    return (
        <div
            className="relative aspect-video bg-black flex items-center justify-center group overflow-hidden rounded-[28px] sm:rounded-[36px]"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => isPlaying && setShowControls(false)}
        >
            <div className="absolute inset-0 bg-gradient-to-br from-gray-900 to-black">
                {decryptError && (
                    <div className="absolute inset-0 flex items-center justify-center z-20 p-8 bg-black/80">
                        <p className="text-sm text-red-400 text-center max-w-md" role="alert">{decryptError}</p>
                    </div>
                )}

                {/* Loading State */}
                {(!isReady || !videoSrc) && !decryptError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 z-10 p-12">
                        <div className="relative">
                           <Loader2 className="w-16 h-16 text-primary animate-spin opacity-20" />
                           <div className="absolute inset-0 flex items-center justify-center">
                              <Zap className="w-6 h-6 text-primary animate-pulse" />
                           </div>
                        </div>
                        
                        <div className="flex flex-col gap-3 w-full max-w-xs">
                             <div className="flex justify-between text-[8px] font-mono text-gray-500 uppercase tracking-widest">
                                <span>Path A: Wi-Fi</span>
                                <span>{Math.min(100, progress * 1.2).toFixed(0)}%</span>
                             </div>
                             <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                                <motion.div 
                                    className="h-full bg-primary"
                                    initial={{ width: 0 }}
                                    animate={{ width: `${Math.min(100, progress * 1.2)}%` }}
                                />
                             </div>

                             <div className="flex justify-between text-[8px] font-mono text-gray-500 uppercase tracking-widest mt-1">
                                <span>Path B: Cellular</span>
                                <span>{Math.min(100, progress * 0.8).toFixed(0)}%</span>
                             </div>
                             <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                                <motion.div 
                                    className="h-full bg-secondary"
                                    initial={{ width: 0 }}
                                    animate={{ width: `${Math.min(100, progress * 0.8)}%` }}
                                />
                             </div>
                        </div>

                        <p className="text-[10px] font-mono text-primary animate-pulse tracking-[0.2em] uppercase mt-2">
                            Hydra Fusing Enabled... {progress}%
                        </p>
                    </div>
                )}

                {/* Ready State - Play Button */}
                {isReady && videoSrc && !isPlaying && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="absolute inset-0 flex items-center justify-center z-10"
                    >
                        <motion.button
                            onClick={handlePlayPause}
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.95 }}
                            className="w-20 h-20 sm:w-24 sm:h-24 bg-primary rounded-full flex items-center justify-center cursor-pointer shadow-[0_0_60px_rgba(0,242,255,0.4)] hover:shadow-[0_0_80px_rgba(0,242,255,0.6)] transition-shadow"
                        >
                            <Play className="w-8 h-8 sm:w-10 sm:h-10 text-black fill-black ml-1" />
                        </motion.button>
                    </motion.div>
                )}

                {/* Video Element */}
                {isReady && videoSrc && (
                    <video
                        ref={videoRef}
                        src={videoSrc}
                        preload="metadata"
                        className="w-full h-full object-contain"
                        onClick={handlePlayPause}
                    />
                )}
            </div>

            {/* Video Controls Overlay */}
            <AnimatePresence>
                {isReady && videoSrc && showControls && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/40 pointer-events-none"
                    >
                        {/* Top Bar - Title & Badges */}
                        <div className="absolute top-4 left-4 right-4 flex justify-between items-start pointer-events-auto">
                            <div className="flex flex-col gap-2">
                                <h2 className="text-base sm:text-xl font-bold tracking-tight truncate max-w-[200px] sm:max-w-md">
                                    {title}
                                </h2>
                                <Badge variant="primary" size="sm">
                                    0ms Playback
                                </Badge>
                            </div>
                        </div>

                        {/* Bottom Controls */}
                        <div className="absolute bottom-0 left-0 right-0 p-4 sm:p-6 pointer-events-auto">
                            {/* Progress Bar */}
                            <div
                                onClick={handleProgressClick}
                                className="w-full h-1 bg-white/20 rounded-full mb-4 cursor-pointer group/progress"
                            >
                                <div
                                    className="h-full bg-primary rounded-full transition-all relative group-hover/progress:h-1.5"
                                    style={{ width: `${progressPercent}%` }}
                                >
                                    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-primary rounded-full opacity-0 group-hover/progress:opacity-100 transition-opacity" />
                                </div>
                            </div>

                            {/* Control Buttons */}
                            <div className="flex items-center justify-between gap-4">
                                <div className="flex items-center gap-3">
                                    {/* Play/Pause */}
                                    <button
                                        onClick={handlePlayPause}
                                        className="w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
                                    >
                                        {isPlaying ? (
                                            <Pause className="w-5 h-5" />
                                        ) : (
                                            <Play className="w-5 h-5 ml-0.5" />
                                        )}
                                    </button>

                                    {/* Volume */}
                                    <button
                                        onClick={handleMuteToggle}
                                        className="w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
                                    >
                                        {isMuted ? (
                                            <VolumeX className="w-5 h-5" />
                                        ) : (
                                            <Volume2 className="w-5 h-5" />
                                        )}
                                    </button>

                                    {/* Time Display */}
                                    <span className="text-xs sm:text-sm font-mono text-white/80 hidden sm:block">
                                        {formatDuration(currentTime)} / {formatDuration(duration)}
                                    </span>
                                </div>

                                <div className="flex items-center gap-2">
                                    {/* Download Button */}
                                    <Button variant="secondary" size="sm" className="hidden sm:flex" onClick={() => {
                                        download().catch((err: unknown) => alert(err instanceof Error ? err.message : String(err)));
                                    }}>
                                        <Download className="w-4 h-4" />
                                        Download Locally
                                    </Button>

                                    {/* Fullscreen */}
                                    <button
                                        onClick={handleFullscreen}
                                        className="w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
                                    >
                                        <Maximize className="w-5 h-5" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
