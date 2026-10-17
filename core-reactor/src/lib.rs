//! Datran core reactor: legacy blob codecs, blob format v2, and evolutionary recipe search.
//! See `docs/EVOLUTION_SPEC.md`; the chunked object store and chunk fusion follow
//! `docs/NETWORK_SPEC.md` §2–§3 (module [`store`]); data gravity (§4) is module [`cluster`].

pub mod classify;
pub mod cluster;
pub mod codec;
pub mod dicts;
pub mod evolution;
pub mod gossip;
pub mod procedural;
pub mod reactor;
pub mod recipe;
pub mod server;
pub mod state;
pub mod store;
pub mod workers;
