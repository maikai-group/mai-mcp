/** Encode one opaque argument for a POSIX shell command string. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** JSON string syntax is a strict subset of TOML basic-string syntax. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}
