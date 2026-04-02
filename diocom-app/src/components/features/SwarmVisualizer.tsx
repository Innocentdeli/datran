'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Node {
    id: number;
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    size: number;
    color: string;
    label: string;
}

export default function SwarmVisualizer() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [nodes, setNodes] = useState<Node[]>([]);
    const [rotation, setRotation] = useState({ x: 0, y: 0 });
    const animationRef = useRef<number>(undefined as any);
    const [hoveredNode, setHoveredNode] = useState<Node | null>(null);
    const mousePos = useRef({ x: 0, y: 0 });

    // Initialize nodes
    useEffect(() => {
        const nodeCount = 50;
        const initialNodes: Node[] = [];
        const cities = ['London', 'New York', 'Tokyo', 'Berlin', 'Paris', 'Seoul', 'Sydney', 'Mumbai'];

        for (let i = 0; i < nodeCount; i++) {
            initialNodes.push({
                id: i,
                x: (Math.random() - 0.5) * 400,
                y: (Math.random() - 0.5) * 400,
                z: (Math.random() - 0.5) * 400,
                vx: (Math.random() - 0.5) * 2,
                vy: (Math.random() - 0.5) * 2,
                vz: (Math.random() - 0.5) * 2,
                size: Math.random() * 5 + 3,
                color: `hsl(${180 + Math.random() * 40}, 80%, ${50 + Math.random() * 20}%)`,
                label: `${cities[Math.floor(Math.random() * cities.length)]}-${i.toString(16).toUpperCase()}`
            });
        }

        setNodes(initialNodes);
    }, []);

    // Animation loop
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const animate = () => {
            // Clear canvas
            ctx.fillStyle = 'rgba(5, 5, 5, 0.4)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            let currentHovered: Node | null = null;

            // Update and draw nodes
            setNodes(prevNodes => {
                const updatedNodes = prevNodes.map(node => {
                    // Physics simulation
                    let newX = node.x * 0.99 + node.vx;
                    let newY = node.y * 0.99 + node.vy;
                    let newZ = node.z * 0.99 + node.vz;

                    // Boundary bounce
                    if (Math.abs(newX) > 200) node.vx *= -1;
                    if (Math.abs(newY) > 200) node.vy *= -1;
                    if (Math.abs(newZ) > 200) node.vz *= -1;

                    return { ...node, x: newX, y: newY, z: newZ };
                });

                // Draw connections
                ctx.strokeStyle = 'rgba(0, 242, 255, 0.05)';
                ctx.lineWidth = 1;

                for (let i = 0; i < updatedNodes.length; i++) {
                    const node1 = project3D(updatedNodes[i], rotation, canvas);

                    // Check for hover
                    const dx = mousePos.current.x - node1.x;
                    const dy = mousePos.current.y - node1.y;
                    if (Math.hypot(dx, dy) < 20) {
                        currentHovered = updatedNodes[i];
                    }

                    for (let j = i + 1; j < updatedNodes.length; j++) {
                        const dist3D = Math.hypot(
                            updatedNodes[i].x - updatedNodes[j].x,
                            updatedNodes[i].y - updatedNodes[j].y,
                            updatedNodes[i].z - updatedNodes[j].z
                        );

                        if (dist3D < 100) {
                            const node2 = project3D(updatedNodes[j], rotation, canvas);
                            ctx.beginPath();
                            ctx.moveTo(node1.x, node1.y);
                            ctx.lineTo(node2.x, node2.y);
                            ctx.stroke();
                        }
                    }
                }

                // Draw nodes
                updatedNodes.forEach(node => {
                    const projected = project3D(node, rotation, canvas);
                    const scale = (perspective / (perspective + node.z));
                    const size = node.size * scale;
                    const isHovered = currentHovered?.id === node.id;

                    // Glow effect
                    const glowSize = isHovered ? size * 4 : size * 2;
                    const gradient = ctx.createRadialGradient(
                        projected.x, projected.y, 0,
                        projected.x, projected.y, glowSize
                    );
                    gradient.addColorStop(0, node.color);
                    gradient.addColorStop(1, 'transparent');

                    ctx.fillStyle = gradient;
                    ctx.beginPath();
                    ctx.arc(projected.x, projected.y, glowSize, 0, Math.PI * 2);
                    ctx.fill();

                    // Core
                    ctx.fillStyle = isHovered ? '#fff' : node.color;
                    ctx.beginPath();
                    ctx.arc(projected.x, projected.y, size, 0, Math.PI * 2);
                    ctx.fill();

                    if (isHovered) {
                        ctx.strokeStyle = '#fff';
                        ctx.lineWidth = 2;
                        ctx.stroke();
                    }
                });

                return updatedNodes;
            });

            if (currentHovered !== hoveredNode) {
                setHoveredNode(currentHovered);
            }

            // Auto-rotate
            setRotation(prev => ({
                x: prev.x + 0.001,
                y: prev.y + 0.002
            }));

            animationRef.current = requestAnimationFrame(animate);
        };

        const perspective = 600;
        animate();

        return () => {
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        };
    }, [rotation, hoveredNode]);

    const handleMouseMove = (e: React.MouseEvent) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
            mousePos.current = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
        }
    };

    // Handle canvas resize
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const resizeCanvas = () => {
            canvas.width = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
        };

        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        return () => window.removeEventListener('resize', resizeCanvas);
    }, []);

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="relative w-full h-[500px] bg-[#050505] rounded-2xl overflow-hidden border border-white/5 shadow-2xl group cursor-crosshair"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => {
                mousePos.current = { x: -100, y: -100 };
                setHoveredNode(null);
            }}
        >
            <canvas ref={canvasRef} className="w-full h-full" />

            {/* Stats Overlay */}
            <div className="absolute top-6 left-6 pointer-events-none">
                <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase tracking-[0.3em] text-primary italic">Live Mesh</span>
                    <span className="text-3xl font-black italic tracking-tighter">SWARM_VIEW</span>
                </div>
            </div>

            {/* Hover Tooltip */}
            <AnimatePresence>
                {hoveredNode && (
                    <motion.div
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                        className="absolute bottom-6 right-6 bg-black/80 backdrop-blur-xl border border-primary/30 p-4 rounded-xl shadow-2xl min-w-[200px]"
                    >
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-[10px] font-mono text-primary font-bold">NODE_INFO</span>
                            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                        </div>
                        <h4 className="text-xl font-black italic tracking-tighter mb-1">{hoveredNode.label}</h4>
                        <div className="space-y-1 text-[10px] font-mono text-gray-400">
                            <div>LATENCY: {(Math.random() * 20 + 5).toFixed(1)}ms</div>
                            <div>UPTIME: 99.9%</div>
                            <div>LOAD: {(Math.random() * 40 + 10).toFixed(0)}%</div>
                            <div className="pt-2 text-primary">STATUS: SYNCED</div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Decorative Grid */}
            <div className="absolute inset-0 pointer-events-none border-[20px] border-black/20" />
        </motion.div>
    );
}


// 3D projection helper
function project3D(
    node: Node,
    rotation: { x: number; y: number },
    canvas: HTMLCanvasElement
): { x: number; y: number } {
    // Rotate around Y axis
    const cosY = Math.cos(rotation.y);
    const sinY = Math.sin(rotation.y);
    const x1 = node.x * cosY - node.z * sinY;
    const z1 = node.x * sinY + node.z * cosY;

    // Rotate around X axis
    const cosX = Math.cos(rotation.x);
    const sinX = Math.sin(rotation.x);
    const y1 = node.y * cosX - z1 * sinX;
    const z2 = node.y * sinX + z1 * cosX;

    // Perspective projection
    const perspective = 600;
    const scale = perspective / (perspective + z2);

    return {
        x: canvas.width / 2 + x1 * scale,
        y: canvas.height / 2 + y1 * scale
    };
}
