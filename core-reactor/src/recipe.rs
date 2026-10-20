//! Compression recipes (spec §2): JSON shape, validation and encoding.

use crate::codec::{self, Codec, DictId, EncodeParams, Filter};
use serde::{Deserialize, Serialize};

fn default_filter() -> Filter {
    Filter::None
}

/// `{ "codec": "zstd", "level": 9, "window_log": 23, "filter": "shuffle", "stride": 4, "dict": "<64 hex>" }`
///
/// Serialization always emits every field in this order. On input, `level` (0), `window_log`
/// (null), `filter` ("none"), `stride` (0) and `dict` (null) may be omitted; unknown fields are ignored.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Recipe {
    pub codec: Codec,
    #[serde(default)]
    pub level: i32,
    #[serde(default)]
    pub window_log: Option<u32>,
    #[serde(default = "default_filter")]
    pub filter: Filter,
    #[serde(default)]
    pub stride: u8,
    #[serde(default)]
    pub dict: Option<String>,
}

impl Recipe {
    pub fn new(codec: Codec, level: i32) -> Recipe {
        Recipe {
            codec,
            level,
            window_log: None,
            filter: Filter::None,
            stride: 0,
            dict: None,
        }
    }

    pub fn with_filter(mut self, filter: Filter, stride: u8) -> Recipe {
        self.filter = filter;
        self.stride = if filter == Filter::None { 0 } else { stride };
        self
    }

    pub fn with_window(mut self, window_log: Option<u32>) -> Recipe {
        self.window_log = window_log;
        self
    }

    pub fn with_dict(mut self, dict: Option<&DictId>) -> Recipe {
        self.dict = dict.map(hex::encode);
        self
    }

    /// The baseline every class starts from and the bench compares against.
    pub fn baseline() -> Recipe {
        Recipe::new(Codec::Zstd, 3)
    }

    /// Allowed level range per codec.
    pub fn level_range(codec: Codec) -> (i32, i32) {
        match codec {
            Codec::Raw | Codec::Lz4 => (0, 0),
            Codec::Deflate => (0, 9),
            Codec::Zstd | Codec::Procedural => (1, 19),
            Codec::Brotli => (0, 11),
        }
    }

    /// Allowed window_log range per codec (None = window_log must be null).
    pub fn window_range(codec: Codec) -> Option<(u32, u32)> {
        match codec {
            Codec::Zstd => Some((10, 27)),
            Codec::Brotli => Some((10, 24)),
            _ => None,
        }
    }

    pub fn default_level(codec: Codec) -> i32 {
        match codec {
            Codec::Raw | Codec::Lz4 => 0,
            Codec::Deflate => 6,
            Codec::Zstd | Codec::Procedural => 3,
            Codec::Brotli => 5,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        let (lo, hi) = Self::level_range(self.codec);
        if self.level < lo || self.level > hi {
            return Err(format!(
                "level {} out of range {}..={} for {}",
                self.level,
                lo,
                hi,
                self.codec.name()
            ));
        }
        match (self.window_log, Self::window_range(self.codec)) {
            (None, _) => {}
            (Some(w), Some((wlo, whi))) if w >= wlo && w <= whi => {}
            (Some(w), _) => {
                return Err(format!(
                    "window_log {} invalid for {}",
                    w,
                    self.codec.name()
                ))
            }
        }
        if !codec::valid_filter_stride(self.filter, self.stride) {
            return Err(format!(
                "stride {} invalid for filter {:?}",
                self.stride, self.filter
            ));
        }
        if let Some(d) = &self.dict {
            if self.codec != Codec::Zstd {
                return Err("dict is only allowed with zstd".into());
            }
            if d.len() != 64
                || !d
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err("dict must be 64 lowercase hex characters".into());
            }
        }
        Ok(())
    }

    /// Parse and validate a recipe from untrusted JSON; invalid ones are dropped (None).
    pub fn from_json_value(v: &serde_json::Value) -> Option<Recipe> {
        let r: Recipe = serde_json::from_value(v.clone()).ok()?;
        r.validate().ok()?;
        Some(r)
    }

    pub fn dict_id(&self) -> Option<DictId> {
        let d = self.dict.as_ref()?;
        let bytes = hex::decode(d).ok()?;
        bytes.try_into().ok()
    }

    /// Compact JSON (used for the `x-reactor-recipe` header).
    pub fn to_compact_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "null".into())
    }

    /// Short human label, e.g. `zstd-9+shuffle4+dict`.
    pub fn label(&self) -> String {
        let mut s = match self.codec {
            Codec::Raw | Codec::Lz4 => self.codec.name().to_string(),
            _ => format!("{}-{}", self.codec.name(), self.level),
        };
        if let Some(w) = self.window_log {
            s.push_str(&format!("/w{}", w));
        }
        match self.filter {
            Filter::None => {}
            Filter::Delta => s.push_str(&format!("+delta{}", self.stride)),
            Filter::Shuffle => s.push_str(&format!("+shuffle{}", self.stride)),
        }
        if self.dict.is_some() {
            s.push_str("+dict");
        }
        s
    }

    /// Encode `data` as a v2 blob. `dict` must be the bytes of `self.dict` when set.
    pub fn encode(&self, data: &[u8], dict: Option<&[u8]>) -> Result<Vec<u8>, String> {
        self.encode_with_workers(data, dict, 0)
    }

    /// [`Recipe::encode`] with zstd multithreading (see [`codec::encode_with_workers`]); used only
    /// for large `/compress` bodies, never for fitness scoring.
    pub fn encode_with_workers(
        &self,
        data: &[u8],
        dict: Option<&[u8]>,
        workers: u32,
    ) -> Result<Vec<u8>, String> {
        self.validate()?;
        let id = self.dict_id();
        let dict_pair = match (&id, dict) {
            (Some(id), Some(bytes)) => Some((id, bytes)),
            (Some(_), None) => return Err("recipe needs a dictionary that is not available".into()),
            (None, _) => None,
        };
        codec::encode_with_workers(
            &EncodeParams {
                codec: self.codec,
                level: self.level,
                window_log: self.window_log,
                filter: self.filter,
                stride: self.stride,
                dict: dict_pair,
            },
            data,
            workers,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_shape_matches_spec() {
        let r = Recipe::new(Codec::Zstd, 9)
            .with_window(Some(23))
            .with_filter(Filter::Shuffle, 4)
            .with_dict(Some(&[0xab; 32]));
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(
            v,
            json!({"codec":"zstd","level":9,"window_log":23,"filter":"shuffle","stride":4,"dict":"ab".repeat(32)})
        );
        assert_eq!(
            Recipe::new(Codec::Lz4, 0).to_compact_json(),
            r#"{"codec":"lz4","level":0,"window_log":null,"filter":"none","stride":0,"dict":null}"#
        );
        assert_eq!(Recipe::from_json_value(&v), Some(r));
        assert_eq!(
            Recipe::from_json_value(&json!({"codec":"lz4"})),
            Some(Recipe::new(Codec::Lz4, 0))
        );
    }

    #[test]
    fn validation_ranges() {
        let bad = [
            json!({"codec":"zstd","level":0}),
            json!({"codec":"zstd","level":20}),
            json!({"codec":"zstd","level":3,"window_log":9}),
            json!({"codec":"zstd","level":3,"window_log":28}),
            json!({"codec":"brotli","level":12}),
            json!({"codec":"brotli","level":5,"window_log":25}),
            json!({"codec":"deflate","level":10}),
            json!({"codec":"deflate","level":6,"window_log":15}),
            json!({"codec":"lz4","level":1}),
            json!({"codec":"raw","filter":"delta","stride":3}),
            json!({"codec":"raw","filter":"delta","stride":0}),
            json!({"codec":"raw","filter":"none","stride":4}),
            json!({"codec":"brotli","level":5,"dict":"00".repeat(32)}),
            json!({"codec":"zstd","level":5,"dict":"zz".repeat(32)}),
            json!({"codec":"zstd","level":5,"dict":"AB".repeat(32)}),
            json!({"codec":"zstd","level":5,"dict":"ab"}),
            json!({"codec":"snappy","level":1}),
            json!({"codec":"procedural","level":0}),
            json!({"codec":"procedural","level":20}),
            json!({"codec":"procedural","level":3,"window_log":20}),
            json!({"codec":"procedural","level":3,"dict":"00".repeat(32)}),
            json!({"codec":"procedural","level":3,"filter":"delta","stride":3}),
            json!({"codec":"zstd","level":5000000000u64}),
            json!("zstd"),
        ];
        for b in bad {
            assert!(Recipe::from_json_value(&b).is_none(), "{}", b);
        }
        let good = [
            json!({"codec":"zstd","level":19,"window_log":27}),
            json!({"codec":"brotli","level":0,"window_log":10}),
            json!({"codec":"deflate","level":0,"filter":"delta","stride":8}),
            json!({"codec":"raw","level":0,"filter":"shuffle","stride":1, "extra": true}),
            json!({"codec":"procedural","level":1,"window_log":null,"filter":"none","stride":0,"dict":null}),
            json!({"codec":"procedural","level":19,"filter":"delta","stride":4}),
        ];
        assert_eq!(
            Recipe::new(Codec::Procedural, 3).to_compact_json(),
            r#"{"codec":"procedural","level":3,"window_log":null,"filter":"none","stride":0,"dict":null}"#
        );
        assert_eq!(Recipe::new(Codec::Procedural, 3).label(), "procedural-3");
        for g in good {
            assert!(Recipe::from_json_value(&g).is_some(), "{}", g);
        }
    }
}
