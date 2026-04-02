'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { motion } from 'framer-motion';

export default function SearchInput() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [query, setQuery] = useState(searchParams.get('q') || '');
    const [debouncedQuery, setDebouncedQuery] = useState(query);

    // Debounce effect
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedQuery(query);
        }, 500);

        return () => clearTimeout(timer);
    }, [query]);

    // Update URL on debounced query change
    useEffect(() => {
        const currentQuery = searchParams.get('q') || '';
        if (debouncedQuery === currentQuery) return;

        const params = new URLSearchParams(searchParams.toString());
        if (debouncedQuery) {
            params.set('q', debouncedQuery);
        } else {
            params.delete('q');
        }
        
        const newSearch = params.toString();
        const newPath = newSearch ? `/dashboard?${newSearch}` : '/dashboard';
        router.push(newPath);
    }, [debouncedQuery, router, searchParams]);

    return (
        <div className="relative w-full">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <Search className="h-4 w-4 text-gray-500 group-focus-within:text-primary transition-colors" />
            </div>
            <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="block w-full pl-12 pr-4 py-3.5 border border-white/[0.08] rounded-2xl leading-5 bg-white/[0.03] text-gray-200 placeholder-gray-600 focus:outline-none focus:bg-white/[0.08] focus:border-primary/40 sm:text-sm transition-all backdrop-blur-md shadow-inner font-medium"
                placeholder="Search history by name or tag..."
            />
            {debouncedQuery && (
                <motion.div
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="absolute right-3 top-1/2 -translate-y-1/2"
                >
                    <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                </motion.div>
            )}
        </div>
    );
}
