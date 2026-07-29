//! Port of `src/render/format.ts` and `src/workflows/text.ts`, including
//! JavaScript-compatible rounding so durations format identically.

use chrono::DateTime;

/// `Math.round`: round half away from zero for positive values.
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// `Number.prototype.toFixed(digits)` for the non-negative values we format.
fn js_to_fixed(value: f64, digits: u32) -> String {
    let factor = 10f64.powi(digits as i32);
    let scaled = js_round(value * factor) as f64 / factor;
    format!("{scaled:.*}", digits as usize)
}

pub fn format_duration(duration_ms: i64) -> String {
    if duration_ms < 1_000 {
        return format!("{}ms", duration_ms.max(0));
    }
    let seconds = duration_ms as f64 / 1_000.0;
    if seconds < 60.0 {
        let digits = if seconds < 10.0 { 1 } else { 0 };
        return format!("{}s", js_to_fixed(seconds, digits));
    }
    let minutes = (seconds / 60.0).floor() as i64;
    let rest = js_round(seconds % 60.0);
    format!("{minutes}m{rest:02}s")
}

/// `Date.parse` for the ISO-8601 timestamps run bundles contain. Returns
/// milliseconds since the epoch, or `None` for unparsable input.
pub fn parse_timestamp_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.timestamp_millis())
}

/// Remove ANSI escape sequences (CSI style) from a string.
pub fn strip_ansi(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut result = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '\u{1b}' && chars.get(index + 1) == Some(&'[') {
            index += 2;
            while index < chars.len() && !chars[index].is_ascii_alphabetic() {
                index += 1;
            }
            index += 1;
            continue;
        }
        result.push(chars[index]);
        index += 1;
    }
    result
}

/// Remove ANSI escapes and control characters from untrusted text so
/// rendering it cannot alter terminal state. Line breaks and tabs collapse
/// to single spaces.
pub fn sanitize_text(text: &str) -> String {
    let stripped = strip_ansi(text);
    let mut result = String::new();
    let mut pending_space = false;
    for char in stripped.chars() {
        if matches!(char, '\t' | '\n' | '\r') {
            pending_space = true;
            continue;
        }
        if pending_space {
            result.push(' ');
            pending_space = false;
        }
        // C0 controls, DEL, and C1 controls (U+0080..U+009F): some terminals
        // treat 8-bit C1 bytes like 0x9B as CSI, so they must go too.
        if ('\u{0}'..='\u{1f}').contains(&char) || ('\u{7f}'..='\u{9f}').contains(&char) {
            continue;
        }
        result.push(char);
    }
    if pending_space {
        result.push(' ');
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_matches_js() {
        assert_eq!(format_duration(0), "0ms");
        assert_eq!(format_duration(-5), "0ms");
        assert_eq!(format_duration(999), "999ms");
        assert_eq!(format_duration(1_000), "1.0s");
        assert_eq!(format_duration(1_050), "1.1s"); // JS (1.05).toFixed(1) === "1.1"
        assert_eq!(format_duration(5_000), "5.0s");
        assert_eq!(format_duration(9_940), "9.9s");
        assert_eq!(format_duration(10_500), "11s"); // JS (10.5).toFixed(0) === "11"
        assert_eq!(format_duration(59_499), "59s");
        assert_eq!(format_duration(60_000), "1m00s");
        assert_eq!(format_duration(90_500), "1m31s"); // Math.round(30.5) === 31
        assert_eq!(format_duration(3_599_000), "59m59s");
    }

    #[test]
    fn sanitize_collapses_control_runs() {
        assert_eq!(sanitize_text("a\n\nb\tc"), "a b c");
        assert_eq!(sanitize_text("\u{1b}[31mred\u{1b}[0m"), "red");
        assert_eq!(sanitize_text("bell\u{7}!"), "bell!");
        // 8-bit C1 controls (e.g. C1 CSI and OSC) must be removed too.
        assert_eq!(sanitize_text("a\u{9b}2Jb"), "a2Jb");
        assert_eq!(sanitize_text("a\u{9d}52;xb"), "a52;xb");
        assert_eq!(sanitize_text("del\u{7f}!"), "del!");
    }
}
