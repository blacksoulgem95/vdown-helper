//! A DASH manifest holds many representations behind one URL. Wherever a URL is passed around (variants, audio tracks,
//! requests) a representation is addressed as `<manifest url>#vdh-rep=<id>` (`src/lib/dash/ref.ts`). The fragment is
//! never sent to a server, so the URL stays a valid, safe http(s) URL everywhere else.

use serde::{Deserialize, Serialize};

use crate::js;

const KEY: &str = "vdh-rep=";

pub fn dash_ref(manifest_url: &str, rep_id: &str) -> String {
    let base = manifest_url.split('#').next().unwrap_or(manifest_url);
    format!("{base}#{KEY}{}", js::encode_uri_component(rep_id))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashRefParts {
    pub manifest_url: String,
    pub rep_id: String,
}

pub fn parse_dash_ref(url: &str) -> Option<DashRefParts> {
    let i = url.find(&format!("#{KEY}"))?;
    let rep_id = js::decode_uri_component(&url[i + 1 + KEY.len()..])?;
    (!rep_id.is_empty()).then(|| DashRefParts {
        manifest_url: url[..i].to_string(),
        rep_id,
    })
}
