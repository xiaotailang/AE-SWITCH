//! Fail-closed native reads and conservative, source-preserving YAML edits.

use super::{check_existing_ancestors, AppError, Path, Result};
use serde_json::{Map, Value};

pub(super) type Snapshot = (std::path::PathBuf, Option<String>);

pub(super) fn snapshot(
    root: &Path,
    path: &Path,
    snapshots: &mut Vec<Snapshot>,
) -> Result<Option<String>> {
    let before = read(root, path)?;
    snapshots.push((path.to_owned(), before.clone()));
    Ok(before)
}

pub(super) fn snapshot_authorized<'a>(
    path: &Path,
    allowed: impl IntoIterator<Item = &'a std::path::PathBuf>,
    snapshots: &mut Vec<Snapshot>,
) -> Result<Option<String>> {
    let before = read_authorized(path, allowed)?;
    snapshots.push((path.to_owned(), before.clone()));
    Ok(before)
}

/// An existing profile grants individual native files, never a filesystem root.
pub(super) fn read_authorized<'a>(
    path: &Path,
    allowed: impl IntoIterator<Item = &'a std::path::PathBuf>,
) -> Result<Option<String>> {
    if !path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
        || !allowed.into_iter().any(|known| known == path)
    {
        return Err(AppError::new(
            "unsafe_path",
            "拒绝读取未选择的客户端配置文件",
        ));
    }
    check_existing_ancestors(path)?;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(AppError::io(path, error)),
    };
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err(invalid(path));
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|error| AppError::io(path, error))
}

/// Native transactions authorize exact selected files, independently from AE's
/// private portable directory. Recheck the grant and ancestors at each atomic
/// writer boundary; never grant an entire external directory.
pub(super) fn write_authorized<'a>(
    path: &Path,
    allowed: impl IntoIterator<Item = &'a std::path::PathBuf>,
    content: Option<&str>,
) -> Result<()> {
    if content.is_some_and(|text| text.len() > 4 * 1024 * 1024) {
        return Err(invalid(path));
    }
    let allowed: Vec<_> = allowed.into_iter().collect();
    crate::writer::write_with_validation(path, content, |target| {
        read_authorized(target, allowed.iter().copied()).map(|_| ())
    })
}

pub(super) fn check_snapshots(root: &Path, snapshots: &[Snapshot]) -> Result<()> {
    for (path, before) in snapshots {
        if &read(root, path)? != before {
            return Err(AppError::new(
                "agent_configuration_changed",
                format!(
                    "{} 在配置期间被修改，原配置未覆盖。请等待工具保存完成后重试",
                    path.display()
                ),
            ));
        }
    }
    Ok(())
}

pub(super) fn invalid(path: &Path) -> AppError {
    AppError::new(
        "invalid_agent_configuration",
        format!(
            "{} 的配置语法或结构不符合预期，原配置未覆盖。请先在原工具中修复后重试",
            path.display()
        ),
    )
}

pub(super) fn read(root: &Path, path: &Path) -> Result<Option<String>> {
    read_limit(root, path, 4 * 1024 * 1024)
}

pub(super) fn read_limit(root: &Path, path: &Path, limit: u64) -> Result<Option<String>> {
    if !path.starts_with(root) {
        return Err(AppError::new(
            "unsafe_path",
            "Agent configuration is outside the portable root",
        ));
    }
    check_existing_ancestors(path)?;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(AppError::io(path, error)),
    };
    if !metadata.is_file() || metadata.len() > limit {
        return Err(invalid(path));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| AppError::io(root, error))?;
    if !path
        .canonicalize()
        .map_err(|error| AppError::io(path, error))?
        .starts_with(canonical_root)
    {
        return Err(AppError::new(
            "unsafe_path",
            "Agent configuration escaped the portable root",
        ));
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|error| AppError::io(path, error))
}

pub(super) fn json(text: Option<&str>, path: &Path, fallback: Value) -> Result<Value> {
    text.map(|text| decode_json(text).map_err(|_| invalid(path)))
        .unwrap_or(Ok(fallback))
}

pub(super) fn decode_json(text: &str) -> std::result::Result<Value, serde_json::Error> {
    struct Unique(Value);
    impl<'de> serde::Deserialize<'de> for Unique {
        fn deserialize<D: serde::Deserializer<'de>>(
            deserializer: D,
        ) -> std::result::Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = Unique;
                fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    formatter.write_str("JSON without duplicate object keys")
                }
                fn visit_bool<E: serde::de::Error>(
                    self,
                    value: bool,
                ) -> std::result::Result<Unique, E> {
                    Ok(Unique(value.into()))
                }
                fn visit_i64<E: serde::de::Error>(
                    self,
                    value: i64,
                ) -> std::result::Result<Unique, E> {
                    Ok(Unique(value.into()))
                }
                fn visit_u64<E: serde::de::Error>(
                    self,
                    value: u64,
                ) -> std::result::Result<Unique, E> {
                    Ok(Unique(value.into()))
                }
                fn visit_f64<E: serde::de::Error>(
                    self,
                    value: f64,
                ) -> std::result::Result<Unique, E> {
                    serde_json::Number::from_f64(value)
                        .map(|number| Unique(Value::Number(number)))
                        .ok_or_else(|| E::custom("non-finite JSON number"))
                }
                fn visit_str<E: serde::de::Error>(
                    self,
                    value: &str,
                ) -> std::result::Result<Unique, E> {
                    Ok(Unique(value.into()))
                }
                fn visit_string<E: serde::de::Error>(
                    self,
                    value: String,
                ) -> std::result::Result<Unique, E> {
                    Ok(Unique(value.into()))
                }
                fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::Null))
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(
                    self,
                    mut sequence: A,
                ) -> std::result::Result<Unique, A::Error> {
                    let mut values = vec![];
                    while let Some(Unique(value)) = sequence.next_element()? {
                        values.push(value);
                    }
                    Ok(Unique(Value::Array(values)))
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(
                    self,
                    mut map: A,
                ) -> std::result::Result<Unique, A::Error> {
                    let mut values = Map::new();
                    while let Some((key, Unique(value))) = map.next_entry::<String, Unique>()? {
                        if values.insert(key, value).is_some() {
                            return Err(serde::de::Error::custom("duplicate JSON object key"));
                        }
                    }
                    Ok(Unique(Value::Object(values)))
                }
            }
            deserializer.deserialize_any(Visitor)
        }
    }
    serde_json::from_str::<Unique>(text).map(|value| value.0)
}

pub(super) fn object<'a>(value: &'a mut Value, path: &Path) -> Result<&'a mut Map<String, Value>> {
    value.as_object_mut().ok_or_else(|| invalid(path))
}

pub(super) fn child<'a>(value: &'a mut Value, key: &str, path: &Path) -> Result<&'a mut Value> {
    let map = object(value, path)?;
    let child = map.entry(key).or_insert_with(|| Value::Object(Map::new()));
    if !child.is_object() {
        return Err(invalid(path));
    }
    Ok(child)
}

pub(super) fn array<'a>(
    value: &'a mut Value,
    key: &str,
    path: &Path,
) -> Result<&'a mut Vec<Value>> {
    object(value, path)?
        .entry(key)
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| invalid(path))
}

pub(super) fn set(value: &mut Value, key: &str, new: Value, path: &Path) -> Result<()> {
    let map = object(value, path)?;
    if let Some(old) = map.get(key) {
        let compatible = match &new {
            Value::String(_) => old.is_string(),
            Value::Bool(_) => old.is_boolean(),
            Value::Number(_) => old.is_number(),
            Value::Array(_) => old.is_array(),
            Value::Object(_) => old.is_object(),
            Value::Null => old.is_null(),
        };
        if !compatible {
            return Err(invalid(path));
        }
    }
    map.insert(key.to_owned(), new);
    Ok(())
}

pub(super) fn default(value: &mut Value, key: &str, new: Value, path: &Path) -> Result<()> {
    if object(value, path)?.contains_key(key) {
        let old = value[key].clone();
        set(value, key, new, path)?;
        value[key] = old;
        Ok(())
    } else {
        set(value, key, new, path)
    }
}

pub(super) fn update_authorization_headers(
    value: &mut Value,
    token: &str,
    path: &Path,
) -> Result<()> {
    let Some(headers) = object(value, path)?.get_mut("headers") else {
        return Ok(());
    };
    let headers = object(headers, path)?;
    let authorization = format!("Bearer {token}");
    for (name, value) in headers {
        if !value.is_string() {
            return Err(invalid(path));
        }
        if name.eq_ignore_ascii_case("authorization") {
            *value = authorization.clone().into();
        }
    }
    Ok(())
}

pub(super) fn rows(value: &mut Value, path: &Path, key: &str) -> Result<()> {
    let rows = value.as_array_mut().ok_or_else(|| invalid(path))?;
    let mut ids = std::collections::HashSet::new();
    for row in rows {
        let row = object(row, path)?;
        let id = row
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(path))?;
        if !ids.insert(id.to_owned()) {
            return Err(invalid(path));
        }
    }
    Ok(())
}

pub(super) fn row<'a>(rows: &'a mut Vec<Value>, key: &str, id: &str) -> &'a mut Value {
    let index = rows
        .iter()
        .position(|row| row.get(key).and_then(Value::as_str) == Some(id))
        .unwrap_or_else(|| {
            rows.push(serde_json::json!({key:id}));
            rows.len() - 1
        });
    &mut rows[index]
}

pub(super) fn selected_model<'a>(
    models: &'a mut Vec<Value>,
    model: &str,
    previous: Option<&str>,
    path: &Path,
) -> Result<&'a mut Value> {
    let mut value = Value::Array(std::mem::take(models));
    rows(&mut value, path, "id")?;
    *models = std::mem::take(value.as_array_mut().expect("validated array"));
    if !models.iter().any(|row| row["id"] == model) {
        let mut next = previous
            .and_then(|previous| models.iter().find(|row| row["id"] == previous))
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        set(&mut next, "id", model.into(), path)?;
        models.push(next);
    }
    Ok(models
        .iter_mut()
        .find(|row| row["id"] == model)
        .expect("selected model exists"))
}

pub(super) fn text(value: &Value) -> Result<String> {
    serde_json::to_string_pretty(value)
        .map(|value| value + "\n")
        .map_err(|_| AppError::new("serialization", "Could not generate agent configuration"))
}

pub(super) fn toml_child<'a>(
    table: &'a mut dyn toml_edit::TableLike,
    key: &str,
    path: &Path,
) -> Result<&'a mut dyn toml_edit::TableLike> {
    if !table.contains_key(key) {
        table.insert(key, toml_edit::Item::Table(toml_edit::Table::new()));
    }
    table
        .get_mut(key)
        .and_then(toml_edit::Item::as_table_like_mut)
        .ok_or_else(|| invalid(path))
}

pub(super) fn toml_set(
    table: &mut dyn toml_edit::TableLike,
    key: &str,
    value: toml_edit::Item,
    path: &Path,
) -> Result<()> {
    if let Some(old) = table.get(key) {
        if (value.as_str().is_some() && old.as_str().is_none())
            || (value.as_bool().is_some() && old.as_bool().is_none())
        {
            return Err(invalid(path));
        }
    }
    if let (Some(old), Some(new)) = (
        table.get(key).and_then(toml_edit::Item::as_value),
        value.as_value(),
    ) {
        let mut new = new.clone();
        *new.decor_mut() = old.decor().clone();
        table.insert(key, toml_edit::Item::Value(new));
    } else {
        table.insert(key, value);
    }
    Ok(())
}

// This editor deliberately accepts a conservative subset rather than pretending
// to validate arbitrary YAML. It supports block maps/lists, ordinary/quoted
// scalars, JSON flow values and opaque block scalars. Aliases, tags, directives,
// complex keys and non-JSON flow collections fail closed. Unchanged source and
// comments remain byte-for-byte; added entries use JSON flow values (valid YAML).
pub(super) struct Yaml {
    source: String,
    node: Node,
}

#[derive(Clone)]
struct Line {
    start: usize,
    end: usize,
    indent: usize,
    body: String,
}

struct Node {
    value: Value,
    start: usize,
    end: usize,
    indent: usize,
    children: Vec<(String, Node)>,
    sequence: bool,
    block: bool,
}

impl Yaml {
    pub(super) fn parse(text: Option<&str>, path: &Path, fallback: Value) -> Result<Self> {
        Self::parse_supported(text, path, fallback).map_err(|_| unsupported_yaml(path))
    }

    fn parse_supported(text: Option<&str>, path: &Path, fallback: Value) -> Result<Self> {
        let source = text.unwrap_or("").to_owned();
        if source.starts_with('\u{feff}') {
            return Err(unsupported_yaml(path));
        }
        if source.trim().is_empty() {
            return Ok(Self {
                source,
                node: Node {
                    value: fallback,
                    start: 0,
                    end: 0,
                    indent: 0,
                    children: vec![],
                    sequence: false,
                    block: false,
                },
            });
        }
        if let Ok(value) = decode_json(&source) {
            check_flow_numbers(&source, path)?;
            let end = source.trim_end().len();
            return Ok(Self {
                source,
                node: Node {
                    value,
                    start: 0,
                    end,
                    indent: 0,
                    children: vec![],
                    sequence: false,
                    block: false,
                },
            });
        }
        let mut offset = 0;
        let mut lines = vec![];
        for raw in source.split_inclusive('\n') {
            let raw_line = raw.trim_end_matches(['\r', '\n']);
            let indent = raw_line.len() - raw_line.trim_start_matches(' ').len();
            if raw_line[..indent].contains('\t') || raw_line[indent..].starts_with('\t') {
                return Err(invalid(path));
            }
            let body = raw_line[indent..].to_owned();
            if !body.trim().is_empty() && !body.starts_with('#') {
                lines.push(Line {
                    start: offset + indent,
                    end: offset + raw_line.len(),
                    indent,
                    body,
                });
            }
            offset += raw.len();
        }
        if lines.is_empty() {
            return Ok(Self {
                source,
                node: Node {
                    value: fallback,
                    start: 0,
                    end: 0,
                    indent: 0,
                    children: vec![],
                    sequence: false,
                    block: false,
                },
            });
        }
        if lines[0].indent != 0 {
            return Err(invalid(path));
        }
        let node = parse_block(&lines, path)?;
        Ok(Self { source, node })
    }

    pub(super) fn value(&self) -> Value {
        self.node.value.clone()
    }

    pub(super) fn render(&self, value: &Value, path: &Path) -> Result<String> {
        let newline = if self.source.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let mut edits = vec![];
        changes(&self.node, value, newline, &mut edits, path)?;
        // At a shared endpoint, insert the parent's additions first so that a
        // later child insertion lands before them at its original indentation.
        let mut edits: Vec<_> = edits.into_iter().enumerate().collect();
        edits.sort_by_key(|(index, edit)| (std::cmp::Reverse(edit.0), std::cmp::Reverse(*index)));
        let mut result = self.source.clone();
        for (_, (start, end, replacement)) in edits {
            result.replace_range(start..end, &replacement);
        }
        if !result.ends_with('\n') {
            result.push_str(newline);
        }
        if Self::parse(Some(&result), path, Value::Null)?.value() != *value {
            return Err(invalid(path));
        }
        Ok(result)
    }
}

fn content_end(text: &str) -> std::result::Result<usize, ()> {
    let mut quote = None;
    let mut escaped = false;
    let chars: Vec<_> = text.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        let (position, character) = chars[i];
        match quote {
            Some('"') if escaped => escaped = false,
            Some('"') if character == '\\' => escaped = true,
            Some('"') if character == '"' => quote = None,
            Some('\'') if character == '\'' => {
                if chars.get(i + 1).is_some_and(|(_, next)| *next == '\'') {
                    i += 1;
                } else {
                    quote = None;
                }
            }
            None if (character == '"' || character == '\'')
                && (position == 0
                    || text[..position].ends_with(|character: char| {
                        character.is_whitespace() || matches!(character, '[' | '{' | ',' | ':')
                    })) =>
            {
                quote = Some(character)
            }
            None if character == '#'
                && (position == 0 || text[..position].ends_with(char::is_whitespace)) =>
            {
                return Ok(position)
            }
            _ => {}
        }
        i += 1;
    }
    if quote.is_some() {
        return Err(());
    }
    Ok(text.len())
}

fn scalar(text: &str, path: &Path) -> Result<Value> {
    let end = content_end(text).map_err(|_| invalid(path))?;
    let text = text[..end].trim();
    if text.is_empty() || matches!(text, "null" | "Null" | "NULL" | "~") {
        return Ok(Value::Null);
    }
    if text.starts_with(['[', '{', '"']) {
        check_flow_numbers(text, path)?;
        return decode_json(text).map_err(|_| invalid(path));
    }
    if let Some(inner) = text
        .strip_prefix('\'')
        .and_then(|text| text.strip_suffix('\''))
    {
        if inner.replace("''", "").contains('\'') {
            return Err(invalid(path));
        }
        return Ok(inner.replace("''", "'").into());
    }
    if text.starts_with(['&', '*', '!', '|', '>', '%', '?', '@', '`'])
        || text == "---"
        || text == "..."
        || text.contains(": ")
        || text.contains("\t")
        || text.contains(['[', ']', '{', '}'])
    {
        return Err(invalid(path));
    }
    match text {
        "true" | "True" | "TRUE" => Ok(true.into()),
        "false" | "False" | "FALSE" => Ok(false.into()),
        _ => {
            let lower = text.to_ascii_lowercase();
            let bytes = text.as_bytes();
            let date = bytes.len() >= 10
                && bytes[..4].iter().all(u8::is_ascii_digit)
                && bytes[4] == b'-'
                && bytes[5..7].iter().all(u8::is_ascii_digit)
                && bytes[7] == b'-'
                && bytes[8..10].iter().all(u8::is_ascii_digit);
            let numeric = text.chars().any(|c| c.is_ascii_digit())
                && text.chars().all(|c| {
                    c.is_ascii_digit() || matches!(c, '+' | '-' | '_' | '.' | ':' | 'e' | 'E')
                });
            let unsigned = lower.trim_start_matches(['+', '-']);
            if matches!(
                lower.as_str(),
                "y" | "n" | "yes" | "no" | "on" | "off" | ".inf" | "-.inf" | "+.inf" | ".nan"
            ) || date
                || ["0x", "0o", "0b"]
                    .iter()
                    .any(|prefix| unsigned.starts_with(prefix))
                || (numeric
                    && (text.contains(['e', 'E', '_', ':', '+'])
                        || serde_json::from_str::<serde_json::Number>(text).is_err()))
            {
                return Err(unsupported_yaml(path));
            }
            Ok(serde_json::from_str::<serde_json::Number>(text)
                .map(Value::Number)
                .unwrap_or_else(|_| text.into()))
        }
    }
}

fn mapping_key(line: &Line, path: &Path) -> Result<(String, usize)> {
    let mut quote = None;
    let mut escape = false;
    for (position, character) in line.body.char_indices() {
        if escape {
            escape = false;
            continue;
        }
        if quote == Some('"') && character == '\\' {
            escape = true;
            continue;
        }
        if Some(character) == quote {
            quote = None;
            continue;
        }
        if quote.is_none() && matches!(character, '\'' | '"') {
            quote = Some(character);
            continue;
        }
        if quote.is_none()
            && character == ':'
            && (position + 1 == line.body.len()
                || line.body[position + 1..].starts_with(char::is_whitespace))
        {
            let key = scalar(&line.body[..position], path)?
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| invalid(path))?;
            if key.is_empty() || key == "<<" {
                return Err(invalid(path));
            }
            return Ok((key, position + 1));
        }
    }
    Err(invalid(path))
}

fn parse_block(lines: &[Line], path: &Path) -> Result<Node> {
    let first = lines.first().ok_or_else(|| invalid(path))?;
    if lines.len() == 1 && first.body.starts_with(['{', '[']) {
        return Ok(Node {
            value: scalar(&first.body, path)?,
            start: first.start,
            end: first.end,
            indent: first.indent,
            children: vec![],
            sequence: false,
            block: false,
        });
    }
    let indent = first.indent;
    let sequence = first.body == "-" || first.body.starts_with("- ");
    let mut value = if sequence {
        Value::Array(vec![])
    } else {
        Value::Object(Map::new())
    };
    let mut children = vec![];
    let mut index = 0;
    while index < lines.len() {
        let line = &lines[index];
        if line.indent != indent {
            return Err(invalid(path));
        }
        let next = (index + 1..lines.len())
            .find(|next| lines[*next].indent <= indent)
            .unwrap_or(lines.len());
        let (key, mut node) = if sequence {
            if !(line.body == "-" || line.body.starts_with("- ")) {
                return Err(invalid(path));
            }
            let prefix = if line.body == "-" { 1 } else { 2 };
            let body = line.body[prefix..].trim_start();
            let start = line.start + line.body.len() - body.len();
            let item = Line {
                start,
                end: line.end,
                indent: indent + 2,
                body: body.to_owned(),
            };
            let node = if body.is_empty() {
                if index + 1 == next {
                    return Err(invalid(path));
                }
                let mut node = parse_block(&lines[index + 1..next], path)?;
                node.start = line.end;
                node
            } else if !body.starts_with(['{', '[', '"', '\'']) && mapping_key(&item, path).is_ok() {
                let mut item_lines = vec![item];
                item_lines.extend_from_slice(&lines[index + 1..next]);
                parse_block(&item_lines, path)?
            } else {
                if index + 1 != next {
                    return Err(invalid(path));
                }
                let end = content_end(body).map_err(|_| invalid(path))?;
                Node {
                    value: scalar(body, path)?,
                    start,
                    end: start + body[..end].trim_end().len(),
                    indent: indent + 2,
                    children: vec![],
                    sequence: false,
                    block: false,
                }
            };
            (children.len().to_string(), node)
        } else {
            let (key, colon) = mapping_key(line, path)?;
            let raw = &line.body[colon..];
            let end = content_end(raw).map_err(|_| invalid(path))?;
            let body = raw[..end].trim();
            let start = line.start + colon + raw.len() - raw.trim_start().len();
            let node = if body.is_empty() && index + 1 < next {
                let mut node = parse_block(&lines[index + 1..next], path)?;
                node.start = line.start + colon;
                node
            } else if matches!(body, "|" | "|-" | "|+" | ">" | ">-" | ">+") {
                // Block scalars are opaque: no reserialization is required for
                // unowned values, including their chomping/folding semantics.
                Node {
                    value: format!(
                        "\u{0}opaque_yaml:{body}\n{}",
                        lines[index + 1..next]
                            .iter()
                            .map(|line| line.body.as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    )
                    .into(),
                    start,
                    end: lines[next - 1].end,
                    indent,
                    children: vec![],
                    sequence: false,
                    block: false,
                }
            } else {
                if index + 1 != next {
                    return Err(invalid(path));
                }
                Node {
                    value: scalar(body, path)?,
                    start,
                    end: line.start + colon + raw[..end].trim_end().len(),
                    indent,
                    children: vec![],
                    sequence: false,
                    block: false,
                }
            };
            (key, node)
        };
        if sequence {
            value
                .as_array_mut()
                .expect("sequence")
                .push(node.value.clone());
        } else if value
            .as_object_mut()
            .expect("mapping")
            .insert(key.clone(), node.value.clone())
            .is_some()
        {
            return Err(invalid(path));
        }
        if node.end < node.start {
            node.end = node.start;
        }
        children.push((key, node));
        index = next;
    }
    Ok(Node {
        value,
        start: first.start,
        end: lines.last().expect("nonempty").end,
        indent,
        children,
        sequence,
        block: true,
    })
}

fn changes(
    node: &Node,
    value: &Value,
    newline: &str,
    edits: &mut Vec<(usize, usize, String)>,
    path: &Path,
) -> Result<()> {
    if node.value == *value {
        return Ok(());
    }
    if node.block {
        let mut additions = String::new();
        if node.sequence {
            let rows = value.as_array().ok_or_else(|| invalid(path))?;
            if rows.len() < node.children.len() {
                return Err(invalid(path));
            }
            for (index, (_, child)) in node.children.iter().enumerate() {
                changes(child, &rows[index], newline, edits, path)?;
            }
            for row in rows.iter().skip(node.children.len()) {
                additions.push_str(&format!(
                    "{newline}{}- {}",
                    " ".repeat(node.indent),
                    encode(row, path)?
                ));
            }
        } else {
            let map = value.as_object().ok_or_else(|| invalid(path))?;
            for (key, child) in &node.children {
                changes(
                    child,
                    map.get(key).ok_or_else(|| invalid(path))?,
                    newline,
                    edits,
                    path,
                )?;
            }
            for (key, value) in map {
                if !node.children.iter().any(|(old, _)| old == key) {
                    additions.push_str(&format!(
                        "{newline}{}{}: {}",
                        " ".repeat(node.indent),
                        serde_json::to_string(key).map_err(|_| invalid(path))?,
                        encode(value, path)?
                    ));
                }
            }
        }
        if !additions.is_empty() {
            edits.push((node.end, node.end, additions));
        }
    } else {
        let mut replacement = encode(value, path)?;
        if node.start == 0 && node.end == 0 {
            replacement.push_str(newline);
        }
        edits.push((node.start, node.end, replacement));
    }
    Ok(())
}

fn encode(value: &Value, path: &Path) -> Result<String> {
    fn opaque(value: &Value) -> bool {
        match value {
            Value::String(value) => value.starts_with("\u{0}opaque_yaml:"),
            Value::Array(values) => values.iter().any(opaque),
            Value::Object(values) => values.values().any(opaque),
            _ => false,
        }
    }
    // Moving/copying an opaque block would require full YAML folding semantics.
    // Fail closed; unchanged blocks are preserved directly from the source.
    if opaque(value) {
        return Err(invalid(path));
    }
    let text = serde_json::to_string(value).map_err(|_| invalid(path))?;
    check_flow_numbers(&text, path)?;
    Ok(text)
}

fn unsupported_yaml(path: &Path) -> AppError {
    AppError::new("unsupported_agent_yaml", format!("{} 使用了暂不支持或有歧义的 YAML 写法，原配置未覆盖。自动合并仅支持缩进对象/数组、常规标量和 JSON 流式值；请为日期或 yes/on 等字符串加引号，或在原工具中调整后重试", path.display()))
}

fn check_flow_numbers(text: &str, path: &Path) -> Result<()> {
    let mut quoted = false;
    let mut escaped = false;
    let mut start = 0;
    let mut tokens = vec![];
    for (index, character) in text.char_indices() {
        if quoted {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
                start = index + 1;
            }
        } else if character == '"' {
            quoted = true;
            start = index + 1;
        } else if character.is_whitespace()
            || matches!(character, ',' | ':' | '[' | ']' | '{' | '}')
        {
            if start < index {
                tokens.push(&text[start..index]);
            }
            start = index + character.len_utf8();
        }
    }
    if !quoted && start < text.len() {
        tokens.push(&text[start..]);
    }
    if tokens.iter().any(|token| {
        token.starts_with(|c: char| c.is_ascii_digit() || c == '-') && token.contains(['e', 'E'])
    }) {
        return Err(unsupported_yaml(path));
    }
    Ok(())
}
