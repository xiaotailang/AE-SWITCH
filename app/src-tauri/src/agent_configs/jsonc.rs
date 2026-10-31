//! OpenCode's native JSONC, with comments and untouched fields preserved.
use super::{native_merge, Path, Result};
use serde_json::Value;

pub(super) struct Document {
    source: String,
    comments_removed: Vec<u8>,
    node: Option<Node>,
    original: Value,
}

struct Node {
    start: usize,
    key_start: usize,
    end: usize,
    value: Value,
    children: Vec<(String, Node)>,
}

impl Document {
    pub(super) fn parse(text: Option<&str>, path: &Path) -> Result<Self> {
        let source = text.unwrap_or("").to_owned();
        if source.trim().is_empty() {
            return Ok(Self {
                source,
                comments_removed: vec![],
                node: None,
                original: serde_json::json!({}),
            });
        }
        let mut clean = source.as_bytes().to_vec();
        let mut offset = usize::from(clean.starts_with(&[0xef, 0xbb, 0xbf])) * 3;
        clean[..offset].fill(b' ');
        while offset < clean.len() {
            if clean[offset] == b'"' {
                offset = string_end(&clean, offset, path)?;
                continue;
            }
            if clean.get(offset..offset + 2) == Some(b"//") {
                let start = offset;
                while offset < clean.len() && clean[offset] != b'\n' {
                    offset += 1;
                }
                clean[start..offset].fill(b' ');
            } else if clean.get(offset..offset + 2) == Some(b"/*") {
                let start = offset;
                offset += 2;
                while offset + 1 < clean.len() && clean.get(offset..offset + 2) != Some(b"*/") {
                    offset += 1;
                }
                if offset + 1 >= clean.len() {
                    return Err(native_merge::invalid(path));
                }
                offset += 2;
                for byte in &mut clean[start..offset] {
                    if !matches!(*byte, b'\n' | b'\r') {
                        *byte = b' ';
                    }
                }
            } else {
                offset += 1;
            }
        }
        let comments_removed = clean.clone();
        offset = 0;
        while offset < clean.len() {
            if clean[offset] == b'"' {
                offset = string_end(&clean, offset, path)?;
                continue;
            }
            if clean[offset] == b',' {
                let mut next = offset + 1;
                whitespace(&clean, &mut next);
                if clean
                    .get(next)
                    .is_some_and(|byte| matches!(byte, b'}' | b']'))
                {
                    clean[offset] = b' ';
                }
            }
            offset += 1;
        }
        let sanitized = std::str::from_utf8(&clean).map_err(|_| native_merge::invalid(path))?;
        let original =
            native_merge::decode_json(sanitized).map_err(|_| native_merge::invalid(path))?;
        if !original.is_object() {
            return Err(native_merge::invalid(path));
        }
        let mut cursor = 0;
        let node = parse_node(&clean, &mut cursor, path)?;
        Ok(Self {
            source,
            comments_removed,
            node: Some(node),
            original,
        })
    }

    pub(super) fn value(&self) -> Value {
        self.original.clone()
    }

    pub(super) fn render(&self, value: &Value, path: &Path) -> Result<String> {
        let Some(node) = &self.node else {
            return native_merge::text(value);
        };
        let newline = if self.source.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let mut edits = vec![];
        self.changes(node, value, newline, &mut edits, path)?;
        edits.sort_by_key(|(start, end, _)| (std::cmp::Reverse(*start), std::cmp::Reverse(*end)));
        let mut rendered = self.source.clone();
        for (start, end, replacement) in edits {
            rendered.replace_range(start..end, &replacement);
        }
        if Self::parse(Some(&rendered), path)?.value() != *value {
            return Err(native_merge::invalid(path));
        }
        Ok(rendered)
    }

    fn changes(
        &self,
        node: &Node,
        next: &Value,
        newline: &str,
        edits: &mut Vec<(usize, usize, String)>,
        path: &Path,
    ) -> Result<()> {
        if node.value == *next {
            return Ok(());
        }
        if let (Some(old), Some(new)) = (node.value.as_object(), next.as_object()) {
            let added: Vec<_> = new
                .iter()
                .filter(|(key, _)| !old.contains_key(*key))
                .collect();
            for (key, child) in &node.children {
                if let Some(value) = new.get(key) {
                    self.changes(child, value, newline, edits, path)?;
                } else {
                    let mut end = child.end;
                    whitespace(&self.comments_removed, &mut end);
                    if self.comments_removed.get(end) == Some(&b',') {
                        end += 1;
                    }
                    edits.push((child.key_start, end, String::new()));
                }
            }
            // A strict JSON client must not acquire a trailing comma when its
            // final property is removed. Keep all untouched comments in place.
            if let Some((last_key, last_child)) = node
                .children
                .iter()
                .rev()
                .find(|(key, _)| new.contains_key(key))
            {
                if added.is_empty() && node.children.last().is_some_and(|(key, _)| key != last_key)
                {
                    let mut comma = last_child.end;
                    whitespace(&self.comments_removed, &mut comma);
                    if self.comments_removed.get(comma) == Some(&b',') {
                        edits.push((comma, comma + 1, String::new()));
                    }
                }
            }
            if !added.is_empty() {
                let line_start = self.source[..node.start]
                    .rfind('\n')
                    .map(|index| index + 1)
                    .unwrap_or(0);
                let indent = self.source[line_start..node.start]
                    .chars()
                    .take_while(|ch| *ch == ' ' || *ch == '\t')
                    .collect::<String>();
                let mut insertion = String::new();
                if let Some((_, last)) = node
                    .children
                    .iter()
                    .rev()
                    .find(|(key, _)| new.contains_key(key))
                {
                    let trailing_comma =
                        self.comments_removed[last.end..node.end - 1].contains(&b',');
                    if !trailing_comma {
                        if last.end == node.end - 1 {
                            insertion.push(',');
                        } else {
                            edits.push((last.end, last.end, ",".into()));
                        }
                    }
                }
                for (index, (key, value)) in added.iter().enumerate() {
                    if index > 0 {
                        insertion.push(',');
                    }
                    insertion.push_str(newline);
                    insertion.push_str(&indent);
                    insertion.push_str("  ");
                    insertion.push_str(
                        &serde_json::to_string(key).map_err(|_| native_merge::invalid(path))?,
                    );
                    insertion.push_str(": ");
                    insertion.push_str(
                        &serde_json::to_string(value).map_err(|_| native_merge::invalid(path))?,
                    );
                }
                insertion.push_str(newline);
                insertion.push_str(&indent);
                edits.push((node.end - 1, node.end - 1, insertion));
            }
        } else {
            edits.push((
                node.start,
                node.end,
                serde_json::to_string(next).map_err(|_| native_merge::invalid(path))?,
            ));
        }
        Ok(())
    }
}

fn whitespace(source: &[u8], offset: &mut usize) {
    while source.get(*offset).is_some_and(u8::is_ascii_whitespace) {
        *offset += 1;
    }
}

fn string_end(source: &[u8], start: usize, path: &Path) -> Result<usize> {
    let mut offset = start + 1;
    while offset < source.len() {
        match source[offset] {
            b'\\' => offset += 2,
            b'"' => return Ok(offset + 1),
            _ => offset += 1,
        }
    }
    Err(native_merge::invalid(path))
}

fn parse_node(source: &[u8], cursor: &mut usize, path: &Path) -> Result<Node> {
    whitespace(source, cursor);
    let start = *cursor;
    let mut children = vec![];
    match source.get(*cursor) {
        Some(b'{') => {
            *cursor += 1;
            whitespace(source, cursor);
            while source.get(*cursor) != Some(&b'}') {
                let key_start = *cursor;
                let key_end = string_end(source, key_start, path)?;
                let key: String = serde_json::from_slice(&source[key_start..key_end])
                    .map_err(|_| native_merge::invalid(path))?;
                *cursor = key_end;
                whitespace(source, cursor);
                *cursor += 1;
                let mut child = parse_node(source, cursor, path)?;
                child.key_start = key_start;
                children.push((key, child));
                whitespace(source, cursor);
                if source.get(*cursor) == Some(&b',') {
                    *cursor += 1;
                    whitespace(source, cursor);
                }
            }
            *cursor += 1;
        }
        Some(b'[') => {
            *cursor += 1;
            whitespace(source, cursor);
            while source.get(*cursor) != Some(&b']') {
                parse_node(source, cursor, path)?;
                whitespace(source, cursor);
                if source.get(*cursor) == Some(&b',') {
                    *cursor += 1;
                    whitespace(source, cursor);
                }
            }
            *cursor += 1;
        }
        Some(b'"') => *cursor = string_end(source, *cursor, path)?,
        _ => {
            while source.get(*cursor).is_some_and(|byte| {
                !byte.is_ascii_whitespace() && !matches!(byte, b',' | b'}' | b']')
            }) {
                *cursor += 1;
            }
        }
    }
    let value =
        serde_json::from_slice(&source[start..*cursor]).map_err(|_| native_merge::invalid(path))?;
    Ok(Node {
        start,
        key_start: start,
        end: *cursor,
        value,
        children,
    })
}
