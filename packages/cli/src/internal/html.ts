export function escapeForScriptTag(json: string): string {
  // Defend against </script> break-out and U+2028/U+2029 line terminators
  // that JSON.stringify emits raw but JS string literals don't accept.
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
