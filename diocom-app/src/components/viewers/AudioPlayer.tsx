'use client';

import { useEffect, useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { Play, Pause, Volume2, VolumeX, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PublicFile } from '@/db/files';
import { useE2ESource } from './useE2ESource';

// Decorative waveform bar heights (fixed so renders stay pure).
const BAR_HEIGHTS = Array.from({ length: 60 }, (_, i) => 20 + ((i * 47 + 13) % 80));

interface AudioPlayerProps {
    fileId: string;
    metadata?: PublicFile;
}

export default function AudioPlayer({ fileId, metadata }: AudioPlayerProps) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const { src: audioSrc, error: decryptError } = useE2ESource(fileId, metadata);
    const isReady = !!audioSrc;
    const audioRef = useRef<HTMLAudioElement>(null);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
        const handleLoadedMetadata = () => setDuration(audio.duration);
        const handleEnded = () => setIsPlaying(false);

        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        audio.addEventListener('ended', handleEnded);

        return () => {
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.removeEventListener('ended', handleEnded);
        };
    }, [isReady, audioSrc]);

    const handlePlayPause = () => {
        if (!audioRef.current) return;
        if (isPlaying) {
            audioRef.current.pause();
        } else {
            audioRef.current.play();
        }
        setIsPlaying(!isPlaying);
    };

    const handleMuteToggle = () => {
        if (!audioRef.current) return;
        audioRef.current.muted = !isMuted;
        setIsMuted(!isMuted);
    };

    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

    if (decryptError) {
        return (
            <div className="flex flex-col items-center justify-center py-20 px-8">
                <p className="text-sm text-red-400 text-center max-w-md" role="alert">{decryptError}</p>
            </div>
        );
    }

    if (!audioSrc) {
        return (
            <div className="flex flex-col items-center justify-center py-20">
                <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
                <p className="text-sm text-primary/70">Loading audio...</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col items-center justify-center py-12 px-8">
            <audio
                ref={audioRef}
                src={audioSrc}
                preload="metadata"
                className="hidden"
            />

            {/* Waveform Visualization (Simulated) */}
            <div className="w-full max-w-2xl mb-8">
                <div className="flex items-center justify-center gap-1 h-32">
                    {Array.from({ length: 60 }).map((_, i) => (
                        <motion.div
                            key={i}
                            className={cn(
                                'w-1 rounded-full transition-colors',
                                i < (progressPercent / 100) * 60 ? 'bg-primary' : 'bg-white/20'
                            )}
                            style={{
                                height: `${BAR_HEIGHTS[i]}%`,
                            }}
                            animate={
                                isPlaying
                                    ? {
                                        scaleY: [1, 1.2, 1],
                                        transition: {
                                            repeat: Infinity,
                                            duration: 0.5,
                                            delay: i * 0.02,
                                        },
                                    }
                                    : {}
                            }
                        />
                    ))}
                </div>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-6">
                <button
                    onClick={handlePlayPause}
                    className="w-16 h-16 bg-primary rounded-full flex items-center justify-center hover:scale-110 transition-transform shadow-[0_0_40px_rgba(0,242,255,0.4)]"
                >
                    {isPlaying ? (
                        <Pause className="w-7 h-7 text-black" />
                    ) : (
                        <Play className="w-7 h-7 text-black ml-1" />
                    )}
                </button>

                <button
                    onClick={handleMuteToggle}
                    className="w-12 h-12 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors"
                >
                    {isMuted ? (
                        <VolumeX className="w-5 h-5" />
                    ) : (
                        <Volume2 className="w-5 h-5" />
                    )}
                </button>
            </div>

            {/* Time Display */}
            <div className="mt-6 text-sm font-mono text-white/60">
                {Math.floor(currentTime / 60)}:{String(Math.floor(currentTime % 60)).padStart(2, '0')} /{' '}
                {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, '0')}
            </div>
        </div>
    );
}
