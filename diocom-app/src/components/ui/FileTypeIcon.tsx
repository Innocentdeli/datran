import { File, FileArchive, FileAudio, FileCode, FileImage, FileText, FileVideo } from 'lucide-react';
import { detectFileType, type FileType } from '@/lib/fileUtils';
import { cn } from '@/lib/utils';

const ICONS: Record<FileType, typeof File> = {
    video: FileVideo,
    image: FileImage,
    audio: FileAudio,
    pdf: FileText,
    document: FileText,
    archive: FileArchive,
    code: FileCode,
    unknown: File,
};

const TONES: Record<FileType, string> = {
    video: 'text-violet-300 bg-violet-500/10 border-violet-400/20',
    image: 'text-sky-300 bg-sky-500/10 border-sky-400/20',
    audio: 'text-pink-300 bg-pink-500/10 border-pink-400/20',
    pdf: 'text-red-300 bg-red-500/10 border-red-400/20',
    document: 'text-blue-300 bg-blue-500/10 border-blue-400/20',
    archive: 'text-amber-300 bg-amber-500/10 border-amber-400/20',
    code: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/20',
    unknown: 'text-gray-300 bg-white/5 border-white/10',
};

/** Square tile with an icon for the file's type (derived from the file name). */
export default function FileTypeIcon({ name, type, size = 'md', className }: { name?: string; type?: FileType; size?: 'sm' | 'md' | 'lg'; className?: string }) {
    const t = type ?? detectFileType(name || '');
    const Icon = ICONS[t];
    return (
        <span
            aria-hidden="true"
            className={cn(
                'grid shrink-0 place-items-center rounded-xl border',
                TONES[t],
                size === 'sm' && 'h-9 w-9',
                size === 'md' && 'h-11 w-11',
                size === 'lg' && 'h-14 w-14 rounded-2xl',
                className
            )}
        >
            <Icon className={size === 'lg' ? 'h-7 w-7' : size === 'md' ? 'h-5 w-5' : 'h-4 w-4'} />
        </span>
    );
}

export function fileTypeLabel(name: string): string {
    const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase() : '';
    return ext && ext.length <= 5 ? ext : detectFileType(name).toUpperCase();
}
