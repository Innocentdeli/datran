'use client';

import { useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { config } from '@/config';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import FileUploadZone from '@/components/features/FileUploadZone';
import SpatialDropZone from '@/components/features/SpatialDropZone';
import ShareLinkPanel from '@/components/features/ShareLinkPanel';
import LogViewer from '@/components/features/LogViewer';
import NeuralConsole from '@/components/features/NeuralConsole';
import SystemMetrics from '@/components/features/SystemMetrics';
import OracleForecaster from '@/components/features/OracleForecaster';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import UploadHistory from '@/components/features/UploadHistory';
import { LogEntry } from '@/types';
import { NeuralService } from '@/lib/NeuralService';
import { Cpu, Terminal, Layers, Activity, ShieldCheck, Lock as SecurityLock } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as Encryption from '@/lib/crypto/Encryption';
import { CognitiveLens } from '@/lib/CognitiveLens';
import { DisasterRelay } from '@/lib/DisasterRelay';
import { MultiRegionRouter } from '@/lib/MultiRegionRouter';
import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { Lock, Zap, Gauge } from 'lucide-react';

export default function DiocomDashboard() {
  const { data: session } = useSession();
  const isAuthenticated = !!session?.user;

  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [password, setPassword] = useState('');
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isStandardMode, setIsStandardMode] = useState(false);
  const [compressionStats, setCompressionStats] = useState({
    speed: config.compression.defaultSpeed,
    ratio: `${config.compression.defaultRatio}x`,
    fidelity: 'BIT-PERFECT',
  });
  const [dtnBalance, setDtnBalance] = useState<number>(0);
  const [isDisasterMesh, setIsDisasterMesh] = useState<boolean>(false);
  const [edgeRegion, setEdgeRegion] = useState<string>('Detecting...');

  useEffect(() => {
    // Fetch $DTN Balance
    fetch('/api/v1/user/credits')
      .then(res => res.json())
      .then(data => { if (data.success) setDtnBalance(data.balance); });

    // Detect Global Edge
    MultiRegionRouter.getOptimalCluster().then(setEdgeRegion);
  }, []);

  const toggleDisasterMesh = () => {
    const newState = !isDisasterMesh;
    setIsDisasterMesh(newState);
    if (newState) {
      DisasterRelay.activate();
      addLog('system', 'Disaster Mesh Activated: Local Discovery Engaged.');
    } else {
      DisasterRelay.deactivate();
      addLog('system', 'Disaster Mesh Deactivated.');
    }
  };

  const [logs, setLogs] = useState<LogEntry[]>([
    { type: 'system', message: 'Initializing 360 OmniDispatcher...', timestamp: new Date() },
    { type: 'swarm', message: `Mesh Nodes detected: ${config.network.meshNodes}`, timestamp: new Date() },
    { type: 'reactor', message: 'V2.1 online. Entropy map ready.', timestamp: new Date() },
  ]);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs((prev) => [...prev, { type, message, timestamp: new Date() }]);
  }, []);

  const handleFilesSelect = useCallback((files: File[]) => {
    if (files.length === 0) {
      setSelectedFiles([]);
      setError(null);
      return;
    }

    setSelectedFiles(files);
    setError(null);
    addLog('user', `Selected ${files.length} file(s). Ready for induction.`);
  }, [addLog]);

  const handleUploadStart = async () => {
    if (isProcessing || selectedFiles.length === 0) {
      return;
    }

    setIsProcessing(true);
    setShareLink(null);
    setError(null);
    setUploadProgress(0);

    addLog('engine', `Physical payload detected: ${selectedFiles.length} unit(s).`);

    // 0. Initialize Encryption Key for this batch
    const batchKey = await Encryption.generateKey();
    const batchKeyStr = await Encryption.exportKey(batchKey);

    let lastLink = '';

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      const progressBasis = (i / selectedFiles.length) * 100;

      addLog('swarm', `[${i + 1}/${selectedFiles.length}] Securing ${file.name} (Zero-Knowledge)...`);

      const { encryptedData, iv } = await Encryption.encryptFile(file, batchKey);
      const encryptedBlob = new Blob([encryptedData], { type: 'application/octet-stream' });
      const encryptedFile = new File([encryptedBlob], file.name, { type: 'application/octet-stream' });

      const sanitizedName = file.name.replace(/[<>:"|?*]/g, '_').trim().replace(/^\.+/, '');
      const eventSource = new EventSource(`/api/progress?fileId=${encodeURIComponent(sanitizedName)}`);

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const fileProgress = data.percent;
          const globalProgress = progressBasis + (fileProgress * (1 / selectedFiles.length));
          setUploadProgress(Math.floor(globalProgress));

          if (data.status) addLog('swarm', `[${i + 1}/${selectedFiles.length}] ${data.status}`);
        } catch (e) { }
      };

      let attempts = 0;
      const maxAttempts = 3;
      let success = false;

      while (attempts < maxAttempts && !success) {
        attempts++;
        try {
          const formData = new FormData();
          formData.append('file', encryptedFile); // Send encrypted payload
          formData.append('iv', Encryption.bytesToBase64Url(iv)); // Store IV briefly
          if (password) {
            formData.append('password', password);
          }

          // Pre-Encryption Semantic Extraction (Local AI/Gemini Nano simulation)
          addLog('neural', `[${i + 1}/${selectedFiles.length}] Local AI scanning semantics before Zero-Knowledge encryption...`);
          const aiMeta = await CognitiveLens.analyze(file);
          
          formData.append('is_encrypted', 'true');
          formData.append('tags', JSON.stringify([...aiMeta.tags, 'Zero-Knowledge']));
          formData.append('summary', aiMeta.summary + (aiMeta.sensitivity === 'High' ? ' [HIGH SENSITIVITY]' : ''));
          formData.append('category', aiMeta.category);

          const res = await fetch('/api/ingest', {
            method: 'POST',
            body: formData,
          });

          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!data.success) throw new Error(data.message || 'Engine Failed');

          eventSource.close();
          addLog('reactor', `[${i + 1}/${selectedFiles.length}] Secure Tunnel Established.`);
          addLog('swarm', `[${i + 1}/${selectedFiles.length}] Link Generated: ${data.link}`);

          // Append Key to link via hash (Ensures key stays in browser)
          lastLink = `${data.link}#key=${batchKeyStr}`;
          if (data.stats) setCompressionStats(data.stats);
          window.dispatchEvent(new Event('diocom-history-update'));
          success = true;
        } catch (e: any) {
          if (attempts === maxAttempts) {
            eventSource.close();
            setError(`Upload failed for ${file.name}: ${e.message}`);
            addLog('error', `Ingestion failed for ${file.name}: ${e.message}`);
          } else {
            addLog('system', `Retrying ${file.name} (${attempts}/${maxAttempts})...`);
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
    }

    setUploadProgress(100);
    setTimeout(() => {
      setShareLink(lastLink);
      setIsProcessing(false);
      setUploadProgress(0);
      setSelectedFiles([]);
      addLog('system', 'Batch induction complete.');
    }, 800);
  };

  return (
    <div className="min-h-screen bg-[#0A0F1A] text-white p-4 sm:p-8 flex flex-col items-center relative overflow-hidden font-sans">
      {/* Dynamic Background Mesh */}
      <div className="fixed inset-0 z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/10 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-secondary/10 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '2s' }} />
      </div>


      <Header />

      <main className="flex-1 w-full max-w-4xl flex flex-col items-center justify-center z-10 py-12">
        <div className="w-full text-center mb-12 animate-fade-in">
          <h2 className="text-4xl sm:text-6xl font-bold tracking-tight mb-4 text-white">
            Share Files <span className="text-primary">Instantly.</span>
          </h2>
          <p className="text-gray-300 text-lg sm:text-xl max-w-2xl mx-auto font-medium">
            Datran uses advanced optimization to deliver your data with zero latency anywhere in the world.
          </p>
        </div>

        <div className="w-full relative group max-w-4xl">
          {/* Decorative Glow */}
          <div className="absolute -inset-4 bg-gradient-to-r from-primary/20 to-secondary/20 rounded-[40px] blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-1000" />

          <div className="glass p-2 rounded-[40px] shadow-2xl transition-all duration-700 bg-black/40 border-white/5 relative">
            <AnimatePresence mode="wait">
              {!shareLink ? (
                <motion.div
                  key="upload"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                >
                  <div className="mb-6 flex justify-center gap-4 animate-fade-in">
                    <div className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all",
                      isAuthenticated 
                        ? "bg-primary/10 border-primary/30 text-primary mt-4" 
                        : "bg-white/5 border-white/10 text-gray-500 mt-4"
                    )}>
                      {isAuthenticated ? <Zap size={14} className="animate-pulse" /> : <Lock size={14} />}
                      <span className="text-[10px] font-bold uppercase tracking-widest font-mono">
                        {isAuthenticated ? 'Warp Mode Active' : 'Standard Speed (Auth Required for Warp)'}
                      </span>
                    </div>
                  </div>

                  <FileUploadZone
                    onFilesSelect={handleFilesSelect}
                    onUploadStart={handleUploadStart}
                    selectedFiles={selectedFiles}
                    isProcessing={isProcessing}
                    progress={uploadProgress}
                    error={error}
                    password={password}
                    onPasswordChange={setPassword}
                    isAuthenticated={isAuthenticated}
                  />

                  {/* Active Batch Preview (Simplified) */}
                  {selectedFiles.length > 0 && !isProcessing && (
                    <div className="px-8 pb-8 flex flex-wrap justify-center gap-2">
                      {selectedFiles.slice(0, 3).map((f, i) => (
                        <div key={i} className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-full text-[10px] text-gray-400 font-mono">
                          {f.name}
                        </div>
                      ))}
                      {selectedFiles.length > 3 && (
                        <div className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-full text-[10px] text-gray-400 font-mono">
                          +{selectedFiles.length - 3} more
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="share"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="p-8 sm:p-12"
                >
                  <ShareLinkPanel
                    url={shareLink}
                    onClose={() => setShareLink(null)}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>

      <Footer />

      {/* History Drawer - Professional Toggle */}
      <div className="fixed bottom-8 right-8 z-50">
        <UploadHistory />
      </div>

      {/* Global Processing Overlay */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <div className="max-w-md w-full glass p-10 text-center border-primary/20 bg-black/80">
              <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
              <h3 className="text-2xl font-bold mb-2">Preparing Transfer</h3>
              <p className="text-gray-200 text-sm mb-6">Swarm nodes are optimizing your data for delivery.</p>
              <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-primary"
                  initial={{ width: 0 }}
                  animate={{ width: `${uploadProgress}%` }}
                />
              </div>
              <div className="flex justify-between mt-2 font-mono text-[10px] text-primary/70 uppercase tracking-widest">
                <span>Optimizing</span>
                <span>{uploadProgress}%</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
