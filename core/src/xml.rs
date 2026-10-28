//! A small, safe XML reader for manifests (MPD, TTML) (`src/lib/xml.ts`). A manifest comes from a hostile page, so it
//! is deliberately limited: no DTD processing and no custom entities (no entity expansion attacks), hard limits on size,
//! depth and node count, and it never fails loudly: it returns `None`.

use serde::Serialize;

use crate::js::is_js_space;

/// Character data, or an element (an index into `children`), in document order.
#[derive(Debug, Clone, PartialEq)]
pub enum XmlContent {
    Text(String),
    Child(usize),
}

/// Serialised like the TypeScript `XmlNode` (`content` holds the child elements themselves).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct XmlNode {
    /// Qualified name as written, e.g. "SegmentTemplate" or "cenc:pssh".
    pub name: String,
    /// Attributes in document order of first appearance (a repeated attribute keeps its first position, last value).
    pub attrs: Attrs,
    pub children: Vec<XmlNode>,
    /// Concatenated character data directly inside this element.
    pub text: String,
    /// Character data and child elements in document order (for mixed content such as subtitles).
    pub content: Vec<XmlContent>,
}

/// An attribute map that keeps insertion order, like a JavaScript object with string keys.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Attrs(Vec<(String, String)>);

impl Attrs {
    pub fn get(&self, k: &str) -> Option<&str> {
        self.0.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
    pub fn set(&mut self, k: &str, v: String) {
        match self.0.iter_mut().find(|(n, _)| n == k) {
            Some(slot) => slot.1 = v,
            None => self.0.push((k.to_string(), v)),
        }
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }
}

impl Serialize for Attrs {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

struct ContentRef<'a>(&'a XmlNode, &'a XmlContent);

impl Serialize for ContentRef<'_> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self.1 {
            XmlContent::Text(t) => s.serialize_str(t),
            XmlContent::Child(i) => self.0.children[*i].serialize(s),
        }
    }
}

impl Serialize for XmlNode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("XmlNode", 5)?;
        st.serialize_field("name", &self.name)?;
        st.serialize_field("attrs", &self.attrs)?;
        st.serialize_field("children", &self.children)?;
        st.serialize_field("text", &self.text)?;
        let content: Vec<ContentRef<'_>> =
            self.content.iter().map(|c| ContentRef(self, c)).collect();
        st.serialize_field("content", &content)?;
        st.end()
    }
}

impl XmlNode {
    fn push_child(&mut self, child: XmlNode) {
        self.content.push(XmlContent::Child(self.children.len()));
        self.children.push(child);
    }

    fn append_text(&mut self, s: &str) {
        self.text.push_str(s);
        match self.content.last_mut() {
            Some(XmlContent::Text(t)) => t.push_str(s),
            _ => self.content.push(XmlContent::Text(s.to_string())),
        }
    }

    /// Direct children with the given local name.
    pub fn children_named<'a>(&'a self, local: &'a str) -> impl Iterator<Item = &'a XmlNode> + 'a {
        self.children
            .iter()
            .filter(move |c| local_name(&c.name) == local)
    }

    pub fn first_child(&self, local: &str) -> Option<&XmlNode> {
        self.children.iter().find(|c| local_name(&c.name) == local)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct XmlLimits {
    pub max_nodes: usize,
    pub max_depth: usize,
}

impl Default for XmlLimits {
    fn default() -> Self {
        Self {
            max_nodes: 200_000,
            max_depth: 64,
        }
    }
}

fn safe_char(code: Option<u32>, fallback: &str, out: &mut String) {
    match code
        .filter(|c| *c > 0 && !(0xD800..=0xDFFF).contains(c))
        .and_then(char::from_u32)
    {
        Some(c) => out.push(c),
        None => out.push_str(fallback),
    }
}

/// `&lt;` `&gt;` `&amp;` `&quot;` `&apos;` and numeric references; unknown (custom) entities are left as written.
pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        // `&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]+);`
        let body_len = if let Some(h) = rest[1..].strip_prefix("#x") {
            let n = h.bytes().take_while(u8::is_ascii_hexdigit).count();
            (1..=6).contains(&n).then_some(2 + n)
        } else if let Some(d) = rest[1..].strip_prefix('#') {
            let n = d.bytes().take_while(u8::is_ascii_digit).count();
            (1..=7).contains(&n).then_some(1 + n)
        } else {
            let n = rest[1..]
                .bytes()
                .take_while(u8::is_ascii_alphabetic)
                .count();
            (n > 0).then_some(n)
        };
        match body_len.filter(|&l| rest.as_bytes().get(1 + l) == Some(&b';')) {
            Some(l) => {
                let whole = &rest[..l + 2];
                let body = &rest[1..1 + l];
                if let Some(h) = body.strip_prefix("#x") {
                    safe_char(u32::from_str_radix(h, 16).ok(), whole, &mut out);
                } else if let Some(d) = body.strip_prefix('#') {
                    safe_char(d.parse().ok(), whole, &mut out);
                } else {
                    match body {
                        "lt" => out.push('<'),
                        "gt" => out.push('>'),
                        "amp" => out.push('&'),
                        "quot" => out.push('"'),
                        "apos" => out.push('\''),
                        _ => out.push_str(whole),
                    }
                }
                rest = &rest[l + 2..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Name without its namespace prefix: "cenc:pssh" -> "pssh".
pub fn local_name(name: &str) -> &str {
    name.find(':').map_or(name, |i| &name[i + 1..])
}

/// `[A-Za-z0-9_:.\-·-�]` per UTF-16 unit: astral characters (surrogate pairs) count as name characters.
fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(c, '_' | ':' | '.' | '-')
        || (c >= '\u{00B7}' && c != '\u{FFFE}' && c != '\u{FFFF}')
}

fn skip_space(src: &str, mut i: usize) -> usize {
    while let Some(c) = src[i..].chars().next() {
        if !is_js_space(c) {
            break;
        }
        i += c.len_utf8();
    }
    i
}

fn find_from(src: &str, pat: &str, from: usize) -> Option<usize> {
    src.get(from..)?.find(pat).map(|p| p + from)
}

/// After the root element only whitespace, comments and processing instructions may follow.
fn only_trailing_noise(src: &str, from: usize) -> bool {
    let mut i = from;
    loop {
        i = skip_space(src, i);
        if i >= src.len() {
            return true;
        }
        let end = if src[i..].starts_with("<!--") {
            find_from(src, "-->", i + 4).map(|e| e + 3)
        } else if src[i..].starts_with("<?") {
            find_from(src, "?>", i + 2).map(|e| e + 2)
        } else {
            return false;
        };
        match end {
            Some(e) => i = e,
            None => return false,
        }
    }
}

pub fn parse_xml(input: &str, limits: XmlLimits) -> Option<XmlNode> {
    let src = input.strip_prefix('\u{FEFF}').unwrap_or(input);
    let n = src.len();
    let mut i = 0;
    let mut nodes = 0;
    // Open elements; a finished element is moved into its parent.
    let mut stack: Vec<XmlNode> = Vec::new();

    while i < n {
        let lt = find_from(src, "<", i);
        let text_end = lt.unwrap_or(n);
        if text_end > i {
            if let Some(top) = stack.last_mut() {
                top.append_text(&decode_entities(&src[i..text_end]));
            }
        }
        let Some(lt) = lt else { break };
        i = lt;
        let here = &src[i..];
        if here.starts_with("<!--") {
            i = find_from(src, "-->", i + 4)? + 3;
        } else if here.starts_with("<![CDATA[") {
            let end = find_from(src, "]]>", i + 9)?;
            let top = stack.last_mut()?;
            top.append_text(&src[i + 9..end]);
            i = end + 3;
        } else if here.starts_with("<?") {
            i = find_from(src, "?>", i + 2)? + 2;
        } else if here.starts_with("<!") {
            // DOCTYPE: skipped, never interpreted. An internal subset (custom entities) is refused outright.
            let end = find_from(src, ">", i + 2)?;
            let decl = &src[i..=end];
            if decl.to_ascii_uppercase().contains("<!ENTITY") || decl.contains('[') {
                return None;
            }
            i = end + 1;
        } else if here.as_bytes().get(1) == Some(&b'/') {
            let end = find_from(src, ">", i + 2)?;
            let name = crate::js::trim(&src[i + 2..end]);
            let open = stack.pop()?;
            if open.name != name {
                return None;
            }
            i = end + 1;
            match stack.last_mut() {
                Some(parent) => parent.push_child(open),
                None => return only_trailing_noise(src, i).then_some(open),
            }
        } else {
            // start tag
            let name_len: usize = here[1..]
                .chars()
                .take_while(|c| is_name_char(*c))
                .map(char::len_utf8)
                .sum();
            let mut j = i + 1 + name_len;
            let name = &src[i + 1..j];
            if name.is_empty() {
                return None;
            }
            let mut node = XmlNode {
                name: name.to_string(),
                ..XmlNode::default()
            };
            let self_closing;
            loop {
                j = skip_space(src, j);
                if j >= n {
                    return None;
                }
                let rest = &src[j..];
                if rest.starts_with('>') {
                    j += 1;
                    self_closing = false;
                    break;
                }
                if rest.starts_with("/>") {
                    j += 2;
                    self_closing = true;
                    break;
                }
                let attr_len: usize = rest
                    .chars()
                    .take_while(|c| is_name_char(*c))
                    .map(char::len_utf8)
                    .sum();
                if attr_len == 0 {
                    return None;
                }
                let attr = &src[j..j + attr_len];
                j = skip_space(src, j + attr_len);
                if src.as_bytes().get(j) != Some(&b'=') {
                    return None;
                }
                j = skip_space(src, j + 1);
                let quote = match src.as_bytes().get(j) {
                    Some(b'"') => "\"",
                    Some(b'\'') => "'",
                    _ => return None,
                };
                let close = find_from(src, quote, j + 1)?;
                node.attrs.set(attr, decode_entities(&src[j + 1..close]));
                j = close + 1;
            }
            nodes += 1;
            if nodes > limits.max_nodes {
                return None;
            }
            i = j;
            if !self_closing {
                if stack.len() + 1 > limits.max_depth {
                    return None;
                }
                stack.push(node);
            } else if let Some(parent) = stack.last_mut() {
                parent.push_child(node);
            } else {
                return only_trailing_noise(src, i).then_some(node);
            }
        }
    }
    None // unclosed elements
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities() {
        assert_eq!(
            decode_entities("a &lt;b&gt; &amp;amp; &#65;&#x42; &foo; &#0; &#x110000; & ;"),
            "a <b> &amp; AB &foo; &#0; &#x110000; & ;"
        );
    }

    #[test]
    fn parses_a_manifest() {
        let x = parse_xml(
            "\u{FEFF}<?xml version=\"1.0\"?><!-- c --><MPD a='1' b=\"x&amp;y\"><Period><BaseURL> v/ </BaseURL><x:y/></Period>tail</MPD>\n<!-- end -->",
            XmlLimits::default(),
        )
        .expect("valid");
        assert_eq!(x.name, "MPD");
        assert_eq!(x.attrs.get("b"), Some("x&y"));
        let p = x.first_child("Period").expect("period");
        assert_eq!(
            p.first_child("BaseURL").map(|b| b.text.as_str()),
            Some(" v/ ")
        );
        assert_eq!(p.first_child("y").map(|n| n.name.as_str()), Some("x:y"));
        assert_eq!(x.text, "tail");
    }

    #[test]
    fn refuses_hostile_input() {
        let l = XmlLimits::default();
        assert!(parse_xml("<!DOCTYPE x [<!ENTITY a \"b\">]><x/>", l).is_none());
        assert!(parse_xml("<a><b></a>", l).is_none());
        assert!(parse_xml("<a/><b/>", l).is_none());
        assert!(parse_xml("<a>", l).is_none());
        assert!(parse_xml(&"<a>".repeat(65), l).is_none());
        assert!(parse_xml("<a/>trailing", l).is_none());
    }
}
