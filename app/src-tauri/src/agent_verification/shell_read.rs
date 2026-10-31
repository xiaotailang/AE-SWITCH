//! Deliberately small read-command grammar. Text in quoted arguments, comments
//! or echo output is never itself an invocation. Unsupported shells fail closed.
fn literal(text: &str) -> Option<(String, &str)> {
    let text = text.trim_start();
    let quote = text.chars().next()?;
    if !matches!(quote, '\'' | '"') {
        return None;
    }
    let mut value = String::new();
    let mut chars = text[1..].char_indices().peekable();
    while let Some((index, c)) = chars.next() {
        if c == quote {
            if quote == '\'' && chars.peek().is_some_and(|(_, next)| *next == '\'') {
                chars.next();
                value.push('\'');
                continue;
            }
            return Some((value, &text[index + 2..]));
        }
        if quote == '"' && matches!(c, '$' | '`') {
            return None;
        }
        value.push(c);
    }
    None
}

fn argument(text: &str) -> Option<(String, &str)> {
    let text = text.trim_start();
    if text.starts_with(['\'', '"']) {
        return literal(text);
    }
    let length = text.find(char::is_whitespace).unwrap_or(text.len());
    let word = &text[..length];
    if word.is_empty() || word.chars().any(|c| "`$;|&<>#(){}".contains(c)) {
        return None;
    }
    Some((word.into(), &text[length..]))
}

pub(super) fn target(command: &str) -> Option<String> {
    let mut text = command.trim();
    // Unwrap one documented -Command envelope, not arbitrary shell code.
    if let Some((executable, mut rest)) = argument(text) {
        let name = executable.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "powershell.exe" | "powershell" | "pwsh.exe" | "pwsh"
        ) {
            loop {
                let (flag, tail) = argument(rest)?;
                rest = tail;
                if flag.eq_ignore_ascii_case("-command") {
                    break;
                }
                if !matches!(
                    flag.to_ascii_lowercase().as_str(),
                    "-noprofile" | "-nologo" | "-noninteractive"
                ) {
                    return None;
                }
            }
            let rest = rest.trim();
            if rest.starts_with('"') && rest.ends_with('"') && rest.len() >= 2 {
                text = &rest[1..rest.len() - 1];
            } else {
                text = rest;
            }
        }
    }
    text = text.trim();
    let mut variable = None;
    if text.starts_with('$') {
        let end = text.find('=')?;
        let name = text[..end].trim();
        if name.len() < 2
            || !name[1..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return None;
        }
        let (value, tail) = literal(&text[end + 1..])?;
        let tail = tail.trim_start().strip_prefix(';')?.trim_start();
        variable = Some((name.to_ascii_lowercase(), value));
        text = tail;
    }
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("get-content ") || lower.starts_with("cat ") || lower.starts_with("type ")
    {
        let (verb, mut rest) = argument(text)?;
        let mut path = None;
        while !rest.trim().is_empty() {
            let (word, tail) = argument(rest)?;
            rest = tail;
            match word.to_ascii_lowercase().as_str() {
                "-literalpath" | "-path" if verb.eq_ignore_ascii_case("get-content") => {
                    let (value, tail) = argument(rest)?;
                    rest = tail;
                    if path.replace(value).is_some() {
                        return None;
                    }
                }
                "-raw" if verb.eq_ignore_ascii_case("get-content") => {}
                "-encoding" | "-erroraction" if verb.eq_ignore_ascii_case("get-content") => {
                    let (value, tail) = argument(rest)?;
                    rest = tail;
                    if !matches!(
                        value.to_ascii_lowercase().as_str(),
                        "utf8" | "utf-8" | "stop"
                    ) {
                        return None;
                    }
                }
                _ if !word.starts_with('-') && path.is_none() => path = Some(word),
                _ => return None,
            }
        }
        return path
            .filter(|path| !path.is_empty() && !path.contains(['$', '`', '\0', '\r', '\n']));
    }
    let prefix = ["[system.io.file]::readalltext(", "[io.file]::readalltext("]
        .into_iter()
        .find(|prefix| lower.starts_with(prefix))?;
    let args = text[prefix.len()..].trim_start();
    let (path, tail) = if args.starts_with('$') {
        let length = args.find([',', ')']).unwrap_or(args.len());
        let name = args[..length].trim().to_ascii_lowercase();
        let (expected, value) = variable?;
        if name != expected {
            return None;
        }
        (value, &args[length..])
    } else {
        literal(args)?
    };
    let tail = tail.trim();
    if tail == ")" || tail == ");" {
        return Some(path);
    }
    let tail = tail.to_ascii_lowercase().replace(' ', "");
    if matches!(
        tail.as_str(),
        ",[system.text.encoding]::utf8)"
            | ",[text.encoding]::utf8)"
            | ",(new-objectsystem.text.utf8encoding($false)))"
            | ",(new-objecttext.utf8encoding($false)))"
    ) {
        Some(path)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_actual_supported_reads_with_explicit_operands_are_accepted() {
        for command in ["Get-Content -LiteralPath 'owned.txt' -Raw", "[IO.File]::ReadAllText('owned.txt')",
            "powershell.exe -Command \"$path='owned.txt'; [System.IO.File]::ReadAllText($path, (New-Object System.Text.UTF8Encoding($false)))\"",
            "cat 'owned.txt'", "type owned.txt",
            "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -NonInteractive -Command \"Get-Content -LiteralPath 'owned.txt' -Raw\""] {
            assert_eq!(target(command).as_deref(), Some("owned.txt"), "{command}");
        }
        for command in [
            "Write-Output 'Get-Content owned.txt MARKER'",
            "echo 'cat owned.txt MARKER'",
            "# Get-Content owned.txt",
            "Get-Content other.txt; echo 'owned.txt MARKER'",
            "Get-Content -LiteralPath '$(echo owned.txt)' -Raw; echo MARKER",
            "gc owned.txt -Raw",
            "[IO.File]::ReadAllText('other.txt'); Write-Output 'owned.txt MARKER'",
            "Get-Content owned.txt > other.txt",
            "cat other.txt # owned.txt",
            "echo Get-Content owned.txt",
        ] {
            assert!(target(command).is_none(), "{command}");
        }
    }
}
