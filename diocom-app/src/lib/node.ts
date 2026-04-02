import { ACSNode } from '../../../src/network/ACSNode';

/**
 * Shared ACSNode Singleton
 * 
 * Ensures that the Ingest, Stream, and Background Evolution logic
 * all share the same memory cache and intelligence.
 */

const globalForNode = global as unknown as { node: ACSNode };

export const node = globalForNode.node || new ACSNode();

if (process.env.NODE_ENV !== 'production') globalForNode.node = node;
