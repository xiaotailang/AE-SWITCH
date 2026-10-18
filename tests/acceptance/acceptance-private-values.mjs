import assert from "node:assert/strict";
export function registerPrivateValue(values, value, endpoint = false) {
  assert.ok(typeof value === "string" && value.length > 0);
  const candidates = new Set([value]);
  if (endpoint) {
    const url = new URL(value);
    for (const item of [
      url.href,
      url.origin,
      url.hostname,
      url.host,
      value.replace(/\/+$/, ""),
    ])
      if (item) candidates.add(item);
  }
  for (const candidate of candidates) {
    const unicode = [...candidate]
      .map(
        (character) =>
          "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
      )
      .join("");
    for (const form of [
      candidate,
      JSON.stringify(candidate).slice(1, -1),
      candidate.replaceAll("/", "\\/"),
      encodeURI(candidate),
      encodeURIComponent(candidate),
      unicode,
      unicode.toUpperCase().replaceAll("\\U", "\\u"),
    ])
      if (form) values.add(form);
  }
}
export function privateFreePlaintext(bytes, values) {
  // Binary databases and compressed stores are retained as hashes plus parsed
  // redacted projection: a byte scan cannot prove their decoded privacy.
  if (bytes.includes(0)) return false;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return false;
  const decoded = text
    .replace(/\\u([a-f0-9]{4})/gi, (_, digits) =>
      String.fromCharCode(parseInt(digits, 16)),
    )
    .replaceAll("\\/", "/");
  return [...values].every(
    (value) =>
      !text.includes(value) &&
      !decoded.includes(value) &&
      !bytes.includes(Buffer.from(value, "utf16le")),
  );
}
