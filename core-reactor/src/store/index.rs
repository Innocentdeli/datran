//! redb index of the chunked object store (NETWORK_SPEC §2): table definitions and the compact
//! fixed-layout binary records stored in them. All multi-byte integers are little-endian except
//! the offset inside `manifest_chunks` keys, which is big-endian so keys sort by offset.

use super::{Id, Result, StoreError};
use redb::{ReadableTable, Table, TableDefinition, WriteTransaction};

/// `file_id → FileRec` (manifest header; the chunk list lives in `manifest_chunks`).
pub const MANIFESTS: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("manifests");
/// `file_id ‖ offset(u64 BE) → chunk_id ‖ len(u32)`: the manifest chunk list, range-addressable.
pub const MANIFEST_CHUNKS: TableDefinition<&[u8; 40], &[u8; 36]> =
    TableDefinition::new("manifest_chunks");
/// `chunk_id → ChunkLoc` (object, offset, len, manifest reference count).
pub const CHUNK_LOC: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("chunk_loc");
/// `object_id → ObjectRec`.
pub const OBJECTS: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("objects");
/// `file_id → pin count`.
pub const PINS: TableDefinition<&[u8; 32], u64> = TableDefinition::new("pins");
/// `file_id → deleted_ms`.
pub const TOMBSTONES: TableDefinition<&[u8; 32], u64> = TableDefinition::new("tombstones");
/// `chunk_id → AccessRec` (decayed co-access / solo counters, flushed from memory).
pub const ACCESS: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("access");
/// `object_id → enqueued_ms`: objects whose refcount reached 0, collected after the grace period.
pub const GC_QUEUE: TableDefinition<&[u8; 32], u64> = TableDefinition::new("gc_queue");
/// `object_id → detected_ms(u64) ‖ reason(utf8)`.
pub const QUARANTINE: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("quarantine");
/// `inventory version → kind(u8: 1 add, 2 remove) ‖ file_id` (delta log for inventory gossip).
pub const FILE_LOG: TableDefinition<u64, &[u8]> = TableDefinition::new("file_log");
/// Transactional counters.
pub const META: TableDefinition<&str, u64> = TableDefinition::new("meta");
/// `pack_id → PackRec` (committed end, live bytes / objects) for every pack file.
pub const PACKS: TableDefinition<u64, &[u8]> = TableDefinition::new("packs");

pub mod meta {
    pub const FILES: &str = "files";
    pub const LOGICAL: &str = "logical_bytes";
    pub const PHYSICAL: &str = "physical_bytes";
    pub const LIVE: &str = "live_bytes";
    pub const UNIQUE: &str = "unique_bytes";
    pub const OBJECTS: &str = "objects";
    pub const SUPER: &str = "super_chunks";
    pub const FUSIONS: &str = "fusions";
    pub const FUSION_SAVED: &str = "fusion_bytes_saved";
    pub const UNFUSIONS: &str = "unfusions";
    pub const READS_SAVED: &str = "reads_saved";
    pub const INVENTORY_VERSION: &str = "inventory_version";
    pub const GC_OBJECTS: &str = "gc_objects";
    pub const GC_BYTES: &str = "gc_bytes";
    pub const QUARANTINED: &str = "quarantined";
    pub const SCRUB_PASSES: &str = "scrub_passes";
    pub const PACK_COMPACTIONS: &str = "pack_compactions";
    pub const PACK_MOVED_OBJECTS: &str = "pack_moved_objects";
    pub const PACK_RECLAIMED: &str = "pack_reclaimed_bytes";
    /// 1 once the per-key-slot object counters were initialised (one-time scan on upgrade).
    pub const ENC_COUNTERS: &str = "enc_counters_v1";
    /// Prefix of `key_slot:<key id> → slot` (1..=63).
    pub const KEY_SLOT_PREFIX: &str = "key_slot:";
    /// Prefix of `enc_objects:<slot> → number of indexed objects sealed under that slot`.
    pub const ENC_OBJECTS_PREFIX: &str = "enc_objects:";

    pub fn enc_objects(slot: u8) -> String {
        format!("{}{}", ENC_OBJECTS_PREFIX, slot)
    }
    pub fn key_slot(key_id: &str) -> String {
        format!("{}{}", KEY_SLOT_PREFIX, key_id)
    }
}

/// `ObjectRec::flags` bits 2..7 hold the key slot.
pub const KEY_SLOT_SHIFT: u8 = 2;
pub const MAX_KEY_SLOT: u8 = 63;

pub const LOG_ADD: u8 = 1;
pub const LOG_REMOVE: u8 = 2;
pub const FLAG_QUARANTINED: u8 = 1;
/// The object lives in a pack file (location appended to the record) instead of its own file.
pub const FLAG_PACKED: u8 = 2;

fn corrupt(what: &str) -> StoreError {
    StoreError::Corrupt(format!("malformed {} record in index", what))
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[at..at + 8]);
    u64::from_le_bytes(a)
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    let mut a = [0u8; 4];
    a.copy_from_slice(&b[at..at + 4]);
    u32::from_le_bytes(a)
}

fn id_at(b: &[u8], at: usize) -> Id {
    let mut a = [0u8; 32];
    a.copy_from_slice(&b[at..at + 32]);
    a
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRec {
    pub size: u64,
    pub chunk_count: u64,
    pub created_ms: u64,
    pub origin: bool,
    pub class: u8,
}

impl FileRec {
    pub fn encode(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(26);
        v.extend_from_slice(&self.size.to_le_bytes());
        v.extend_from_slice(&self.chunk_count.to_le_bytes());
        v.extend_from_slice(&self.created_ms.to_le_bytes());
        v.push(self.origin as u8);
        v.push(self.class);
        v
    }
    pub fn decode(b: &[u8]) -> Result<FileRec> {
        if b.len() != 26 {
            return Err(corrupt("manifest"));
        }
        Ok(FileRec {
            size: u64_at(b, 0),
            chunk_count: u64_at(b, 8),
            created_ms: u64_at(b, 16),
            origin: b[24] != 0,
            class: b[25],
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkLoc {
    pub object: Id,
    pub offset: u32,
    pub len: u32,
    /// Number of manifest occurrences referencing this chunk.
    pub refs: u64,
}

impl ChunkLoc {
    pub fn encode(&self) -> [u8; 48] {
        let mut v = [0u8; 48];
        v[..32].copy_from_slice(&self.object);
        v[32..36].copy_from_slice(&self.offset.to_le_bytes());
        v[36..40].copy_from_slice(&self.len.to_le_bytes());
        v[40..48].copy_from_slice(&self.refs.to_le_bytes());
        v
    }
    pub fn decode(b: &[u8]) -> Result<ChunkLoc> {
        if b.len() != 48 {
            return Err(corrupt("chunk_loc"));
        }
        Ok(ChunkLoc {
            object: id_at(b, 0),
            offset: u32_at(b, 32),
            len: u32_at(b, 36),
            refs: u64_at(b, 40),
        })
    }
}

/// Where a packed object's record starts: `(pack_id, byte offset of the record header)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PackLoc {
    pub pack: u64,
    pub offset: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectRec {
    pub stored_len: u64,
    pub plain_len: u64,
    /// Number of `chunk_loc` entries with refs > 0 that point at this object.
    pub refcount: u64,
    pub created_ms: u64,
    pub class: u8,
    /// `FLAG_QUARANTINED`; `FLAG_PACKED` is derived from `pack` when encoding.
    pub flags: u8,
    /// Member chunk ids in plaintext order (one for a plain chunk object, several for a super-chunk).
    pub members: Vec<Id>,
    /// Plaintext length of each member (same order as `members`).
    pub lens: Vec<u32>,
    /// Pack record location; `None` = the object is its own file under `objects/` (the layout of
    /// every object written before packing existed, and of objects ≥ the pack threshold).
    pub pack: Option<PackLoc>,
}

impl ObjectRec {
    /// Layout: `stored_len, plain_len, refcount, created_ms (u64 each), class u8, flags u8,
    /// n u32, n × (member id, len u32)` and, when `flags & FLAG_PACKED`, `pack_id u64, offset u64`.
    /// Records written before packing existed have no trailer and decode as file objects.
    pub fn encode(&self) -> Vec<u8> {
        debug_assert_eq!(self.members.len(), self.lens.len());
        let mut v = Vec::with_capacity(54 + 36 * self.members.len());
        v.extend_from_slice(&self.stored_len.to_le_bytes());
        v.extend_from_slice(&self.plain_len.to_le_bytes());
        v.extend_from_slice(&self.refcount.to_le_bytes());
        v.extend_from_slice(&self.created_ms.to_le_bytes());
        v.push(self.class);
        let flags = (self.flags & !FLAG_PACKED) | if self.pack.is_some() { FLAG_PACKED } else { 0 };
        v.push(flags);
        v.extend_from_slice(&(self.members.len() as u32).to_le_bytes());
        for (m, l) in self.members.iter().zip(&self.lens) {
            v.extend_from_slice(m);
            v.extend_from_slice(&l.to_le_bytes());
        }
        if let Some(p) = self.pack {
            v.extend_from_slice(&p.pack.to_le_bytes());
            v.extend_from_slice(&p.offset.to_le_bytes());
        }
        v
    }
    pub fn decode(b: &[u8]) -> Result<ObjectRec> {
        if b.len() < 38 {
            return Err(corrupt("object"));
        }
        let n = u32_at(b, 34) as usize;
        let flags = b[33];
        let packed = flags & FLAG_PACKED != 0;
        let body = 38 + 36 * n;
        if b.len() != body + if packed { 16 } else { 0 } {
            return Err(corrupt("object"));
        }
        Ok(ObjectRec {
            stored_len: u64_at(b, 0),
            plain_len: u64_at(b, 8),
            refcount: u64_at(b, 16),
            created_ms: u64_at(b, 24),
            class: b[32],
            flags: flags & !FLAG_PACKED,
            members: (0..n).map(|i| id_at(b, 38 + 36 * i)).collect(),
            lens: (0..n).map(|i| u32_at(b, 38 + 36 * i + 32)).collect(),
            pack: packed.then(|| PackLoc {
                pack: u64_at(b, body),
                offset: u64_at(b, body + 8),
            }),
        })
    }
    pub fn quarantined(&self) -> bool {
        self.flags & FLAG_QUARANTINED != 0
    }
    /// Slot of the master key the stored bytes are sealed under (flag bits 2..7; 0 = plaintext,
    /// which is what every row written before encryption existed decodes as).
    pub fn key_slot(&self) -> u8 {
        self.flags >> KEY_SLOT_SHIFT
    }
    pub fn set_key_slot(&mut self, slot: u8) {
        self.flags = (self.flags & ((1 << KEY_SLOT_SHIFT) - 1)) | (slot << KEY_SLOT_SHIFT);
    }
    pub fn is_super(&self) -> bool {
        self.members.len() > 1
    }
    /// `(offset, len)` of a member chunk inside the plaintext.
    pub fn member_span(&self, id: &Id) -> Option<(u32, u32)> {
        let mut off = 0u32;
        for (m, l) in self.members.iter().zip(&self.lens) {
            if m == id {
                return Some((off, *l));
            }
            off += l;
        }
        None
    }
}

/// Per-pack bookkeeping. `end` is the committed length of the pack file: every indexed record
/// lies below it (bytes beyond it after a crash are a torn / uncommitted tail and are truncated
/// on startup). Dead bytes = `end − PACK_HEADER − live_bytes` (orphan, superseded, quarantined
/// and collected records).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PackRec {
    pub end: u64,
    /// Sum of record sizes (header + stored bytes) of indexed objects located in this pack.
    pub live_bytes: u64,
    pub live_objects: u64,
}

impl PackRec {
    pub fn encode(&self) -> [u8; 24] {
        let mut v = [0u8; 24];
        v[..8].copy_from_slice(&self.end.to_le_bytes());
        v[8..16].copy_from_slice(&self.live_bytes.to_le_bytes());
        v[16..].copy_from_slice(&self.live_objects.to_le_bytes());
        v
    }
    pub fn decode(b: &[u8]) -> Result<PackRec> {
        if b.len() != 24 {
            return Err(corrupt("pack"));
        }
        Ok(PackRec {
            end: u64_at(b, 0),
            live_bytes: u64_at(b, 8),
            live_objects: u64_at(b, 16),
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AccessRec {
    /// Decayed number of requests that read this chunk together with other chunks.
    pub co: f64,
    /// Decayed number of requests that read only this chunk.
    pub solo: f64,
    pub last_ms: u64,
}

impl AccessRec {
    pub fn encode(&self) -> [u8; 24] {
        let mut v = [0u8; 24];
        v[..8].copy_from_slice(&self.co.to_le_bytes());
        v[8..16].copy_from_slice(&self.solo.to_le_bytes());
        v[16..].copy_from_slice(&self.last_ms.to_le_bytes());
        v
    }
    pub fn decode(b: &[u8]) -> Result<AccessRec> {
        if b.len() != 24 {
            return Err(corrupt("access"));
        }
        Ok(AccessRec {
            co: f64::from_bits(u64_at(b, 0)),
            solo: f64::from_bits(u64_at(b, 8)),
            last_ms: u64_at(b, 16),
        })
    }
    /// Counters decayed to `now` with half-life `half_life_ms`.
    pub fn decayed(&self, now: u64, half_life_ms: u64) -> AccessRec {
        let f = decay_factor(self.last_ms, now, half_life_ms);
        AccessRec {
            co: self.co * f,
            solo: self.solo * f,
            last_ms: now.max(self.last_ms),
        }
    }
}

pub fn decay_factor(last_ms: u64, now: u64, half_life_ms: u64) -> f64 {
    if half_life_ms == 0 {
        return 1.0;
    }
    let dt = now.saturating_sub(last_ms) as f64;
    0.5f64.powf(dt / half_life_ms as f64)
}

pub fn mchunk_key(file: &Id, offset: u64) -> [u8; 40] {
    let mut k = [0u8; 40];
    k[..32].copy_from_slice(file);
    k[32..].copy_from_slice(&offset.to_be_bytes());
    k
}

pub fn mchunk_key_offset(k: &[u8; 40]) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&k[32..]);
    u64::from_be_bytes(a)
}

pub fn mchunk_val(chunk: &Id, len: u32) -> [u8; 36] {
    let mut v = [0u8; 36];
    v[..32].copy_from_slice(chunk);
    v[32..].copy_from_slice(&len.to_le_bytes());
    v
}

pub fn mchunk_val_decode(v: &[u8; 36]) -> (Id, u32) {
    (id_at(v, 0), u32_at(v, 32))
}

/// Every table, opened in one write transaction.
pub struct Tables<'t> {
    pub manifests: Table<'t, &'static [u8; 32], &'static [u8]>,
    pub mchunks: Table<'t, &'static [u8; 40], &'static [u8; 36]>,
    pub chunk_loc: Table<'t, &'static [u8; 32], &'static [u8]>,
    pub objects: Table<'t, &'static [u8; 32], &'static [u8]>,
    pub pins: Table<'t, &'static [u8; 32], u64>,
    pub tombstones: Table<'t, &'static [u8; 32], u64>,
    pub access: Table<'t, &'static [u8; 32], &'static [u8]>,
    pub gc: Table<'t, &'static [u8; 32], u64>,
    pub quarantine: Table<'t, &'static [u8; 32], &'static [u8]>,
    pub file_log: Table<'t, u64, &'static [u8]>,
    pub meta: Table<'t, &'static str, u64>,
    pub packs: Table<'t, u64, &'static [u8]>,
}

impl<'t> Tables<'t> {
    pub fn open(tx: &'t WriteTransaction) -> Result<Tables<'t>> {
        Ok(Tables {
            packs: tx.open_table(PACKS)?,
            manifests: tx.open_table(MANIFESTS)?,
            mchunks: tx.open_table(MANIFEST_CHUNKS)?,
            chunk_loc: tx.open_table(CHUNK_LOC)?,
            objects: tx.open_table(OBJECTS)?,
            pins: tx.open_table(PINS)?,
            tombstones: tx.open_table(TOMBSTONES)?,
            access: tx.open_table(ACCESS)?,
            gc: tx.open_table(GC_QUEUE)?,
            quarantine: tx.open_table(QUARANTINE)?,
            file_log: tx.open_table(FILE_LOG)?,
            meta: tx.open_table(META)?,
        })
    }

    pub fn meta_get(&self, key: &str) -> Result<u64> {
        Ok(self.meta.get(key)?.map(|g| g.value()).unwrap_or(0))
    }

    pub fn meta_add(&mut self, key: &str, delta: i64) -> Result<u64> {
        let cur = self.meta_get(key)?;
        let next = if delta >= 0 {
            cur.saturating_add(delta as u64)
        } else {
            cur.saturating_sub(delta.unsigned_abs())
        };
        self.meta.insert(key, next)?;
        Ok(next)
    }

    pub fn get_loc(&self, id: &Id) -> Result<Option<ChunkLoc>> {
        self.chunk_loc
            .get(id)?
            .map(|g| ChunkLoc::decode(g.value()))
            .transpose()
    }

    pub fn put_loc(&mut self, id: &Id, loc: &ChunkLoc) -> Result<()> {
        self.chunk_loc.insert(id, loc.encode().as_slice())?;
        Ok(())
    }

    pub fn get_obj(&self, id: &Id) -> Result<Option<ObjectRec>> {
        self.objects
            .get(id)?
            .map(|g| ObjectRec::decode(g.value()))
            .transpose()
    }

    pub fn put_obj(&mut self, id: &Id, rec: &ObjectRec) -> Result<()> {
        self.objects.insert(id, rec.encode().as_slice())?;
        Ok(())
    }

    pub fn get_file(&self, id: &Id) -> Result<Option<FileRec>> {
        self.manifests
            .get(id)?
            .map(|g| FileRec::decode(g.value()))
            .transpose()
    }

    pub fn get_pack(&self, pack: u64) -> Result<Option<PackRec>> {
        self.packs
            .get(pack)?
            .map(|g| PackRec::decode(g.value()))
            .transpose()
    }

    /// An indexed object now lives at `loc` (record of `stored_len` payload bytes). Also raises the
    /// pack's committed end to cover the record, in the same transaction that indexes it, so
    /// startup truncation can never cut an indexed record.
    pub fn pack_link(&mut self, loc: PackLoc, stored_len: u64) -> Result<()> {
        let size = super::pack::record_size(stored_len);
        let mut p = self.get_pack(loc.pack)?.unwrap_or_default();
        p.end = p.end.max(loc.offset + size);
        p.live_bytes += size;
        p.live_objects += 1;
        self.packs.insert(loc.pack, p.encode().as_slice())?;
        Ok(())
    }

    /// The record at `loc` is no longer referenced by the index (collected, quarantined, moved).
    pub fn pack_unlink(&mut self, loc: PackLoc, stored_len: u64) -> Result<()> {
        let size = super::pack::record_size(stored_len);
        let Some(mut p) = self.get_pack(loc.pack)? else {
            return Err(StoreError::Corrupt(format!(
                "pack {} missing from index",
                loc.pack
            )));
        };
        p.live_bytes = p.live_bytes.saturating_sub(size);
        p.live_objects = p.live_objects.saturating_sub(1);
        self.packs.insert(loc.pack, p.encode().as_slice())?;
        Ok(())
    }

    /// Inserts a new object row (refcount 0, i.e. not yet live) and updates the counters.
    pub fn insert_object(&mut self, id: &Id, rec: &ObjectRec) -> Result<()> {
        debug_assert_eq!(rec.refcount, 0);
        if let Some(loc) = rec.pack {
            self.pack_link(loc, rec.stored_len)?;
        }
        self.put_obj(id, rec)?;
        self.meta_add(meta::PHYSICAL, rec.stored_len as i64)?;
        self.meta_add(meta::OBJECTS, 1)?;
        self.meta_add(&meta::enc_objects(rec.key_slot()), 1)?;
        if rec.is_super() {
            self.meta_add(meta::SUPER, 1)?;
        }
        Ok(())
    }

    /// One more live chunk_loc entry points at `obj`.
    pub fn obj_ref_inc(&mut self, obj: &Id) -> Result<()> {
        let mut rec = self.get_obj(obj)?.ok_or_else(|| {
            StoreError::Corrupt(format!("object {} missing from index", hex::encode(obj)))
        })?;
        if rec.refcount == 0 {
            self.gc.remove(obj)?;
            self.meta_add(meta::LIVE, rec.stored_len as i64)?;
            self.meta_add(meta::UNIQUE, rec.plain_len as i64)?;
        }
        rec.refcount += 1;
        self.put_obj(obj, &rec)
    }

    /// One fewer live chunk_loc entry points at `obj`; at zero it is queued for GC.
    pub fn obj_ref_dec(&mut self, obj: &Id, now: u64) -> Result<()> {
        let Some(mut rec) = self.get_obj(obj)? else {
            return Err(StoreError::Corrupt(format!(
                "object {} missing from index",
                hex::encode(obj)
            )));
        };
        if rec.refcount == 0 {
            return Err(StoreError::Corrupt(format!(
                "object {} refcount underflow",
                hex::encode(obj)
            )));
        }
        rec.refcount -= 1;
        if rec.refcount == 0 {
            self.gc.insert(obj, now)?;
            self.meta_add(meta::LIVE, -(rec.stored_len as i64))?;
            self.meta_add(meta::UNIQUE, -(rec.plain_len as i64))?;
        }
        self.put_obj(obj, &rec)
    }

    /// Adds `k` manifest references to an indexed chunk.
    pub fn chunk_ref_add(&mut self, id: &Id, mut loc: ChunkLoc, k: u64) -> Result<()> {
        if loc.refs == 0 && k > 0 {
            self.obj_ref_inc(&loc.object)?;
        }
        loc.refs += k;
        self.put_loc(id, &loc)
    }

    /// Removes `k` manifest references from a chunk.
    pub fn chunk_ref_sub(&mut self, id: &Id, k: u64, now: u64) -> Result<()> {
        let Some(mut loc) = self.get_loc(id)? else {
            return Err(StoreError::Corrupt(format!(
                "chunk {} missing from index",
                hex::encode(id)
            )));
        };
        if loc.refs < k {
            return Err(StoreError::Corrupt(format!(
                "chunk {} refcount underflow",
                hex::encode(id)
            )));
        }
        loc.refs -= k;
        self.put_loc(id, &loc)?;
        if loc.refs == 0 && k > 0 {
            self.obj_ref_dec(&loc.object, now)?;
        }
        Ok(())
    }

    pub fn log_event(&mut self, kind: u8, file: &Id) -> Result<u64> {
        let v = self.meta_add(meta::INVENTORY_VERSION, 1)?;
        let mut rec = [0u8; 33];
        rec[0] = kind;
        rec[1..].copy_from_slice(file);
        self.file_log.insert(v, rec.as_slice())?;
        Ok(v)
    }
}

/// Creates every table so read transactions can open them.
pub fn init(tx: &WriteTransaction) -> Result<()> {
    Tables::open(tx).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_roundtrip() {
        let f = FileRec {
            size: 1 << 40,
            chunk_count: 7,
            created_ms: 123,
            origin: true,
            class: 3,
        };
        assert_eq!(FileRec::decode(&f.encode()).unwrap(), f);
        let l = ChunkLoc {
            object: [7; 32],
            offset: 99,
            len: 65536,
            refs: 5,
        };
        assert_eq!(ChunkLoc::decode(&l.encode()).unwrap(), l);
        let o = ObjectRec {
            stored_len: 1,
            plain_len: 2,
            refcount: 3,
            created_ms: 4,
            class: 5,
            flags: 1,
            members: vec![[1; 32], [2; 32]],
            lens: vec![7, 9],
            pack: None,
        };
        assert_eq!(ObjectRec::decode(&o.encode()).unwrap(), o);
        assert!(o.quarantined() && o.is_super());
        // packed records carry their location; pre-pack records (no trailer) decode as file objects
        let p = ObjectRec {
            pack: Some(PackLoc {
                pack: 3,
                offset: 1 << 33,
            }),
            flags: 0,
            ..o.clone()
        };
        let enc = p.encode();
        assert_eq!(enc.len(), o.encode().len() + 16);
        assert_eq!(ObjectRec::decode(&enc).unwrap(), p);
        assert!(
            ObjectRec::decode(&enc[..enc.len() - 16]).is_err(),
            "flag without trailer"
        );
        let pr = PackRec {
            end: 99,
            live_bytes: 50,
            live_objects: 2,
        };
        assert_eq!(PackRec::decode(&pr.encode()).unwrap(), pr);
        assert_eq!(o.member_span(&[2; 32]), Some((7, 9)));
        let a = AccessRec {
            co: 1.5,
            solo: 0.25,
            last_ms: 9,
        };
        assert_eq!(AccessRec::decode(&a.encode()).unwrap(), a);
        assert!(ObjectRec::decode(&[0u8; 10]).is_err());
        let k = mchunk_key(&[9; 32], 0x0102_0304_0506);
        assert_eq!(mchunk_key_offset(&k), 0x0102_0304_0506);
        assert!(mchunk_key(&[9; 32], 256) > mchunk_key(&[9; 32], 255));
        let d = a.decayed(9 + 1000, 1000);
        assert!((d.co - 0.75).abs() < 1e-12);
    }
}
