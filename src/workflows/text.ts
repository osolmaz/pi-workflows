/** Remove ANSI escape sequences (CSI style) from a string. */
export function stripAnsi(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\u001b" && text[index + 1] === "[") {
      index += 2;
      while (index < text.length && !/[A-Za-z]/.test(text[index] as string)) {
        index += 1;
      }
      index += 1;
      continue;
    }
    result += text[index];
    index += 1;
  }
  return result;
}

/**
 * Remove ANSI escapes and control characters from untrusted text (model
 * outputs, errors, titles) so rendering it cannot alter terminal state. Line
 * breaks and tabs collapse to single spaces because callers interpolate the
 * result into single terminal lines, where a stray newline would break
 * viewport math and allow fake rows.
 */
export function sanitizeText(text: string): string {
  return (
    stripAnsi(text)
      .replaceAll(/[\t\n\r]+/g, " ")
      // eslint-disable-next-line no-control-regex
      .replaceAll(/[\u0000-\u001f\u007f]/g, "")
  );
}
