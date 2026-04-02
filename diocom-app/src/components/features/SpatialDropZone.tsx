'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, File, Database, Zap, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    size: number;
    color: string;
    life: number;
    maxLife: number;
    name?: string;
}

interface SpatialDropZoneProps {
    onFilesSelect: (files: File[]) => void;
    isProcessing: boolean;
    selectedFiles: File[];
    isAuthenticated?: boolean;
}

export default function SpatialDropZone({ onFilesSelect, isProcessing, selectedFiles, isAuthenticated = false }: SpatialDropZoneProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [isDragOver, setIsDragOver] = useState(false);
    const particles = useRef<Particle[]>([]);
    const requestRef = useRef<number>(0);

    // Initialize canvas size
    useEffect(() => {
        const handleResize = () => {
            if (canvasRef.current && containerRef.current) {
                canvasRef.current.width = containerRef.current.offsetWidth;
                canvasRef.current.height = containerRef.current.offsetHeight;
            }
        };

        handleResize();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const createParticle = (x: number, y: number, name?: string) => {
        const colors = ['#00f2ff', '#7000ff', '#00ffaa'];
        return {
            x,
            y,
            vx: (Math.random() - 0.5) * 10,
            vy: (Math.random() - 0.5) * 10,
            size: name ? 4 : Math.random() * 3 + 1,
            color: colors[Math.floor(Math.random() * colors.length)],
            life: 1,
            maxLife: name ? 2 : 1,
            name
        };
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(true);

        // Spawn particles at mouse position
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
            for (let i = 0; i < 3; i++) {
                particles.current.push(createParticle(e.clientX - rect.left, e.clientY - rect.top));
            }
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);

        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            onFilesSelect(files);

            // Spawn named particles for files
            const rect = canvasRef.current?.getBoundingClientRect();
            if (rect) {
                files.forEach((file, idx) => {
                    particles.current.push(createParticle(
                        e.clientX - rect.left + (Math.random() - 0.5) * 50,
                        e.clientY - rect.top + (Math.random() - 0.5) * 50,
                        file.name
                    ));
                });
            }
        }
    };

    const animate = (time: number) => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Update and draw particles
        particles.current = particles.current.filter(p => {
            p.x += p.vx;
            p.y += p.vy;
            p.life -= 0.01;

            // Bounce
            if (p.x < 0 || p.x > canvas.width) p.vx *= -0.8;
            if (p.y < 0 || p.y > canvas.height) p.vy *= -0.8;

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fillStyle = p.color + Math.floor(p.life * 255).toString(16).padStart(2, '0');
            ctx.fill();

            if (p.name) {
                ctx.font = '10px Roboto Mono';
                ctx.fillStyle = `rgba(255, 255, 255, ${p.life})`;
                ctx.fillText(p.name, p.x + 10, p.y + 5);
            }

            return p.life > 0;
        });

        // Draw connections if drag over
        if (isDragOver && particles.current.length > 1) {
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(0, 242, 255, 0.1)';
            for (let i = 0; i < particles.current.length; i++) {
                const p1 = particles.current[i];
                for (let j = i + 1; j < particles.current.length; j++) {
                    const p2 = particles.current[j];
                    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
                    if (dist < 100) {
                        ctx.moveTo(p1.x, p1.y);
                        ctx.lineTo(p2.x, p2.y);
                    }
                }
            }
            ctx.stroke();
        }

        requestRef.current = requestAnimationFrame(animate);
    };

    useEffect(() => {
        requestRef.current = requestAnimationFrame(animate);
        return () => {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
        };
    }, [isDragOver]);

    return (
        <div
            ref={containerRef}
            className={cn(
                "relative w-full h-80 rounded-2xl overflow-hidden border-2 border-dashed transition-all duration-500",
                isDragOver ? "border-primary bg-primary/5 scale-[1.01] shadow-[0_0_40px_rgba(0,242,255,0.1)]" : "border-white/10 bg-black/40 hover:border-white/20",
                isProcessing && "pointer-events-none opacity-50"
            )}
            onDragOver={handleDragOver}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => document.getElementById('spatial-input')?.click()}
        >
            <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />

            <input
                id="spatial-input"
                type="file"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && onFilesSelect(Array.from(e.target.files))}
            />

            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 select-none pointer-events-none">
                <AnimatePresence mode="wait">
                    {selectedFiles.length === 0 ? (
                        <motion.div
                            key="empty"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            className="flex flex-col items-center"
                        >
                            <div className="w-20 h-20 rounded-3xl bg-primary/10 flex items-center justify-center mb-6 border border-primary/20 shadow-xl ring-8 ring-primary/5">
                                <Upload className="w-10 h-10 text-primary" />
                            </div>
                            <h3 className="text-2xl font-bold tracking-tight text-white mb-2">Drop files here</h3>
                            <p className="text-gray-400 text-sm font-medium">Or click to browse your computer</p>
                        </motion.div>
                    ) : (
                        <motion.div
                            key="selected"
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="flex flex-col items-center"
                        >
                            <div className="flex -space-x-4 mb-6">
                                {selectedFiles.slice(0, 3).map((f, i) => (
                                    <div key={i} className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center shadow-2xl ring-4 ring-[#0A0F1A]">
                                        <File className="w-8 h-8 text-white" />
                                    </div>
                                ))}
                                {selectedFiles.length > 3 && (
                                    <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-white/10 flex items-center justify-center shadow-2xl ring-4 ring-[#0A0F1A] text-sm font-bold">
                                        +{selectedFiles.length - 3}
                                    </div>
                                )}
                            </div>
                            <h3 className="text-2xl font-bold tracking-tight text-white mb-2">
                                {selectedFiles.length} {selectedFiles.length === 1 ? 'file' : 'files'} selected
                            </h3>
                            <div className="flex gap-6 mt-2">
                                <div className="flex items-center gap-2 text-xs font-medium text-gray-400 capitalize">
                                    <Database className="w-4 h-4 text-gray-500" />
                                    {(selectedFiles.reduce((acc, f) => acc + f.size, 0) / 1024 / 1024).toFixed(2)} MB
                                </div>
                                <div className="flex items-center gap-2 text-xs font-semibold text-primary uppercase tracking-widest">
                                    <Zap className="w-4 h-4" />
                                    Ready to Transfer
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Decorative corners */}
            <div className="absolute top-2 left-2 w-4 h-4 border-t-2 border-l-2 border-primary/30 rounded-tl-sm" />
            <div className="absolute top-2 right-2 w-4 h-4 border-t-2 border-r-2 border-primary/30 rounded-tr-sm" />
            <div className="absolute bottom-2 left-2 w-4 h-4 border-b-2 border-l-2 border-primary/30 rounded-bl-sm" />
            <div className="absolute bottom-2 right-2 w-4 h-4 border-b-2 border-r-2 border-primary/30 rounded-br-sm" />

            {/* Guest Overlay */}
            {!isAuthenticated && (
                <div className="absolute inset-0 z-50 bg-[#0A0F1A]/80 backdrop-blur-[2px] flex flex-col items-center justify-center p-6 text-center">
                    <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mb-4">
                        <Lock className="w-6 h-6 text-gray-400" />
                    </div>
                    <h4 className="text-white font-bold text-sm mb-1">Login Required</h4>
                    <p className="text-slate-500 text-[10px] max-w-[180px] leading-relaxed mb-4">
                        Sign in to drop files into this shared team space.
                    </p>
                    <button 
                        onClick={(e) => { e.stopPropagation(); window.location.href='/auth/signin'; }}
                        className="px-4 py-2 bg-violet-500/10 hover:bg-violet-500/20 border border-violet-500/20 text-violet-400 text-[10px] font-bold rounded-lg transition-all"
                    >
                        Sign In
                    </button>
                </div>
            )}
        </div>
    );
}
