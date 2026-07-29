use anyhow::{Context, Result};
use ratatui::style::Color;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use toml_edit::{value, DocumentMut};

pub const THEME_NAMES: &[&str] = &[
    "catppuccin",
    "catppuccin-latte",
    "terminal",
    "tokyo-night",
    "tokyo-night-day",
    "dracula",
    "nord",
    "gruvbox",
    "gruvbox-light",
    "one-dark",
    "one-light",
    "solarized",
    "solarized-light",
    "kanagawa",
    "kanagawa-lotus",
    "rose-pine",
    "rose-pine-dawn",
    "vesper",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Palette {
    pub name: String,
    pub app_bg: Color,
    pub panel_bg: Color,
    pub canvas_bg: Color,
    pub node_bg: Color,
    pub node_focus_bg: Color,
    pub selection_bg: Color,
    pub surface_dim: Color,
    pub border: Color,
    pub border_focused: Color,
    pub text: Color,
    pub subtext: Color,
    pub muted: Color,
    pub accent: Color,
    pub replay_focus: Color,
    pub running: Color,
    pub success: Color,
    pub warning: Color,
    pub error: Color,
    pub timed_out: Color,
    pub cancelled: Color,
    pub branch: Color,
    pub user: Color,
    pub assistant: Color,
    pub tool: Color,
    pub timeline_track: Color,
    pub timeline_fill: Color,
    pub timeline_thumb: Color,
}

#[allow(clippy::too_many_arguments)]
fn palette(
    name: &str,
    app_bg: Color,
    panel_bg: Color,
    canvas_bg: Color,
    surface0: Color,
    surface1: Color,
    overlay0: Color,
    overlay1: Color,
    text: Color,
    subtext: Color,
    mauve: Color,
    green: Color,
    yellow: Color,
    red: Color,
    blue: Color,
    teal: Color,
    peach: Color,
) -> Palette {
    Palette {
        name: name.to_string(),
        app_bg,
        panel_bg,
        canvas_bg,
        node_bg: surface0,
        node_focus_bg: surface1,
        selection_bg: surface0,
        surface_dim: canvas_bg,
        border: overlay0,
        border_focused: blue,
        text,
        subtext,
        muted: overlay1,
        accent: blue,
        replay_focus: mauve,
        running: blue,
        success: green,
        warning: yellow,
        error: red,
        timed_out: peach,
        cancelled: mauve,
        branch: teal,
        user: teal,
        assistant: green,
        tool: yellow,
        timeline_track: surface0,
        timeline_fill: blue,
        timeline_thumb: text,
    }
}

fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color::Rgb(r, g, b)
}

impl Palette {
    pub fn catppuccin() -> Self {
        palette(
            "catppuccin",
            rgb(17, 17, 27),
            rgb(24, 24, 37),
            rgb(30, 30, 46),
            rgb(49, 50, 68),
            rgb(69, 71, 90),
            rgb(108, 112, 134),
            rgb(127, 132, 156),
            rgb(205, 214, 244),
            rgb(166, 173, 200),
            rgb(203, 166, 247),
            rgb(166, 227, 161),
            rgb(249, 226, 175),
            rgb(243, 139, 168),
            rgb(137, 180, 250),
            rgb(148, 226, 213),
            rgb(250, 179, 135),
        )
    }

    pub fn catppuccin_latte() -> Self {
        palette(
            "catppuccin-latte",
            rgb(220, 224, 232),
            rgb(239, 241, 245),
            rgb(230, 233, 239),
            rgb(204, 208, 218),
            rgb(188, 192, 204),
            rgb(156, 160, 176),
            rgb(140, 143, 161),
            rgb(76, 79, 105),
            rgb(108, 111, 133),
            rgb(136, 57, 239),
            rgb(64, 160, 43),
            rgb(223, 142, 29),
            rgb(210, 15, 57),
            rgb(30, 102, 245),
            rgb(23, 146, 153),
            rgb(254, 100, 11),
        )
    }

    pub fn terminal() -> Self {
        palette(
            "terminal",
            Color::Reset,
            Color::Reset,
            Color::Reset,
            Color::DarkGray,
            Color::Gray,
            Color::DarkGray,
            Color::Gray,
            Color::Reset,
            Color::Gray,
            Color::Magenta,
            Color::Green,
            Color::Yellow,
            Color::LightRed,
            Color::Blue,
            Color::Cyan,
            Color::LightYellow,
        )
    }

    pub fn tokyo_night() -> Self {
        palette(
            "tokyo-night",
            rgb(22, 22, 30),
            rgb(26, 27, 38),
            rgb(26, 27, 38),
            rgb(36, 40, 59),
            rgb(65, 72, 104),
            rgb(86, 95, 137),
            rgb(105, 113, 150),
            rgb(192, 202, 245),
            rgb(169, 177, 214),
            rgb(187, 154, 247),
            rgb(158, 206, 106),
            rgb(224, 175, 104),
            rgb(247, 118, 142),
            rgb(122, 162, 247),
            rgb(125, 207, 255),
            rgb(255, 158, 100),
        )
    }

    pub fn tokyo_night_day() -> Self {
        palette(
            "tokyo-night-day",
            rgb(210, 211, 218),
            rgb(225, 226, 231),
            rgb(225, 226, 231),
            rgb(196, 200, 218),
            rgb(168, 174, 203),
            rgb(137, 144, 179),
            rgb(104, 112, 154),
            rgb(55, 96, 191),
            rgb(97, 114, 176),
            rgb(120, 71, 189),
            rgb(88, 117, 57),
            rgb(140, 108, 62),
            rgb(245, 42, 101),
            rgb(46, 125, 233),
            rgb(17, 140, 116),
            rgb(177, 92, 0),
        )
    }

    pub fn dracula() -> Self {
        palette(
            "dracula",
            rgb(30, 31, 40),
            rgb(40, 42, 54),
            rgb(40, 42, 54),
            rgb(68, 71, 90),
            rgb(98, 114, 164),
            rgb(98, 114, 164),
            rgb(130, 140, 180),
            rgb(248, 248, 242),
            rgb(210, 210, 220),
            rgb(255, 121, 198),
            rgb(80, 250, 123),
            rgb(241, 250, 140),
            rgb(255, 85, 85),
            rgb(139, 233, 253),
            rgb(139, 233, 253),
            rgb(255, 184, 108),
        )
    }

    pub fn nord() -> Self {
        palette(
            "nord",
            rgb(36, 41, 51),
            rgb(46, 52, 64),
            rgb(46, 52, 64),
            rgb(59, 66, 82),
            rgb(67, 76, 94),
            rgb(76, 86, 106),
            rgb(100, 110, 130),
            rgb(236, 239, 244),
            rgb(216, 222, 233),
            rgb(180, 142, 173),
            rgb(163, 190, 140),
            rgb(235, 203, 139),
            rgb(191, 97, 106),
            rgb(129, 161, 193),
            rgb(143, 188, 187),
            rgb(208, 135, 112),
        )
    }

    pub fn gruvbox() -> Self {
        palette(
            "gruvbox",
            rgb(29, 32, 33),
            rgb(40, 40, 40),
            rgb(40, 40, 40),
            rgb(60, 56, 54),
            rgb(80, 73, 69),
            rgb(146, 131, 116),
            rgb(168, 153, 132),
            rgb(235, 219, 178),
            rgb(213, 196, 161),
            rgb(211, 134, 155),
            rgb(184, 187, 38),
            rgb(250, 189, 47),
            rgb(251, 73, 52),
            rgb(131, 165, 152),
            rgb(142, 192, 124),
            rgb(254, 128, 25),
        )
    }

    pub fn gruvbox_light() -> Self {
        palette(
            "gruvbox-light",
            rgb(242, 229, 188),
            rgb(251, 241, 199),
            rgb(251, 241, 199),
            rgb(235, 219, 178),
            rgb(213, 196, 161),
            rgb(146, 131, 116),
            rgb(124, 111, 100),
            rgb(60, 56, 54),
            rgb(80, 73, 69),
            rgb(143, 63, 113),
            rgb(121, 116, 14),
            rgb(181, 118, 20),
            rgb(157, 0, 6),
            rgb(7, 102, 120),
            rgb(66, 123, 88),
            rgb(175, 58, 3),
        )
    }

    pub fn one_dark() -> Self {
        palette(
            "one-dark",
            rgb(33, 37, 43),
            rgb(40, 44, 52),
            rgb(40, 44, 52),
            rgb(44, 49, 58),
            rgb(62, 68, 81),
            rgb(92, 99, 112),
            rgb(115, 122, 135),
            rgb(171, 178, 191),
            rgb(150, 156, 168),
            rgb(198, 120, 221),
            rgb(152, 195, 121),
            rgb(229, 192, 123),
            rgb(224, 108, 117),
            rgb(97, 175, 239),
            rgb(86, 182, 194),
            rgb(209, 154, 102),
        )
    }

    pub fn one_light() -> Self {
        palette(
            "one-light",
            rgb(245, 245, 246),
            rgb(250, 250, 250),
            rgb(250, 250, 250),
            rgb(240, 240, 241),
            rgb(229, 229, 230),
            rgb(160, 161, 167),
            rgb(104, 107, 119),
            rgb(56, 58, 66),
            rgb(104, 107, 119),
            rgb(166, 38, 164),
            rgb(80, 161, 79),
            rgb(193, 132, 1),
            rgb(228, 86, 73),
            rgb(64, 120, 242),
            rgb(1, 132, 188),
            rgb(152, 104, 1),
        )
    }

    pub fn solarized() -> Self {
        palette(
            "solarized",
            rgb(0, 36, 45),
            rgb(0, 43, 54),
            rgb(0, 43, 54),
            rgb(7, 54, 66),
            rgb(88, 110, 117),
            rgb(88, 110, 117),
            rgb(101, 123, 131),
            rgb(147, 161, 161),
            rgb(131, 148, 150),
            rgb(211, 54, 130),
            rgb(133, 153, 0),
            rgb(181, 137, 0),
            rgb(220, 50, 47),
            rgb(38, 139, 210),
            rgb(42, 161, 152),
            rgb(203, 75, 22),
        )
    }

    pub fn solarized_light() -> Self {
        palette(
            "solarized-light",
            rgb(238, 232, 213),
            rgb(253, 246, 227),
            rgb(253, 246, 227),
            rgb(238, 232, 213),
            rgb(147, 161, 161),
            rgb(147, 161, 161),
            rgb(88, 110, 117),
            rgb(101, 123, 131),
            rgb(131, 148, 150),
            rgb(211, 54, 130),
            rgb(133, 153, 0),
            rgb(181, 137, 0),
            rgb(220, 50, 47),
            rgb(38, 139, 210),
            rgb(42, 161, 152),
            rgb(203, 75, 22),
        )
    }

    pub fn kanagawa() -> Self {
        palette(
            "kanagawa",
            rgb(22, 22, 29),
            rgb(31, 31, 40),
            rgb(31, 31, 40),
            rgb(42, 42, 55),
            rgb(54, 54, 70),
            rgb(114, 113, 105),
            rgb(135, 134, 125),
            rgb(220, 215, 186),
            rgb(200, 195, 170),
            rgb(149, 127, 184),
            rgb(118, 148, 106),
            rgb(192, 163, 110),
            rgb(195, 64, 67),
            rgb(126, 156, 216),
            rgb(127, 180, 202),
            rgb(255, 160, 102),
        )
    }

    pub fn kanagawa_lotus() -> Self {
        palette(
            "kanagawa-lotus",
            rgb(213, 206, 163),
            rgb(242, 236, 188),
            rgb(242, 236, 188),
            rgb(220, 213, 172),
            rgb(201, 203, 209),
            rgb(160, 156, 172),
            rgb(138, 137, 128),
            rgb(84, 84, 100),
            rgb(67, 67, 108),
            rgb(98, 76, 131),
            rgb(111, 137, 78),
            rgb(119, 113, 63),
            rgb(200, 64, 83),
            rgb(77, 105, 155),
            rgb(78, 140, 162),
            rgb(204, 109, 0),
        )
    }

    pub fn rose_pine() -> Self {
        palette(
            "rose-pine",
            rgb(18, 16, 27),
            rgb(25, 23, 36),
            rgb(25, 23, 36),
            rgb(31, 29, 46),
            rgb(38, 35, 58),
            rgb(110, 106, 134),
            rgb(144, 140, 170),
            rgb(224, 222, 244),
            rgb(200, 197, 220),
            rgb(196, 167, 231),
            rgb(49, 116, 143),
            rgb(246, 193, 119),
            rgb(235, 111, 146),
            rgb(49, 116, 143),
            rgb(156, 207, 216),
            rgb(234, 154, 151),
        )
    }

    pub fn rose_pine_dawn() -> Self {
        palette(
            "rose-pine-dawn",
            rgb(242, 233, 225),
            rgb(250, 244, 237),
            rgb(250, 244, 237),
            rgb(242, 233, 225),
            rgb(255, 250, 243),
            rgb(152, 147, 165),
            rgb(121, 117, 147),
            rgb(70, 66, 97),
            rgb(121, 117, 147),
            rgb(144, 122, 169),
            rgb(40, 105, 131),
            rgb(234, 157, 52),
            rgb(180, 99, 122),
            rgb(40, 105, 131),
            rgb(86, 148, 159),
            rgb(215, 130, 126),
        )
    }

    pub fn vesper() -> Self {
        palette(
            "vesper",
            rgb(16, 16, 16),
            rgb(26, 26, 26),
            rgb(26, 26, 26),
            rgb(35, 35, 35),
            rgb(40, 40, 40),
            rgb(92, 92, 92),
            rgb(126, 126, 126),
            rgb(255, 255, 255),
            rgb(160, 160, 160),
            rgb(255, 209, 168),
            rgb(153, 255, 228),
            rgb(255, 199, 153),
            rgb(255, 128, 128),
            rgb(176, 176, 176),
            rgb(102, 221, 204),
            rgb(255, 199, 153),
        )
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match normalize_name(name).as_str() {
            "catppuccin" | "catppuccin-mocha" => Some(Self::catppuccin()),
            "catppuccin-latte" | "latte" | "light" => Some(Self::catppuccin_latte()),
            "terminal" => Some(Self::terminal()),
            "tokyo-night" | "tokyonight" => Some(Self::tokyo_night()),
            "tokyo-night-day" | "tokyo-day" | "tokyonight-day" => Some(Self::tokyo_night_day()),
            "dracula" => Some(Self::dracula()),
            "nord" => Some(Self::nord()),
            "gruvbox" | "gruvbox-dark" => Some(Self::gruvbox()),
            "gruvbox-light" => Some(Self::gruvbox_light()),
            "one-dark" | "onedark" => Some(Self::one_dark()),
            "one-light" | "onelight" => Some(Self::one_light()),
            "solarized" | "solarized-dark" => Some(Self::solarized()),
            "solarized-light" => Some(Self::solarized_light()),
            "kanagawa" => Some(Self::kanagawa()),
            "kanagawa-lotus" | "lotus" => Some(Self::kanagawa_lotus()),
            "rose-pine" | "rosepine" => Some(Self::rose_pine()),
            "rose-pine-dawn" | "rosepine-dawn" | "dawn" => Some(Self::rose_pine_dawn()),
            "vesper" => Some(Self::vesper()),
            _ => None,
        }
    }

    fn apply_overrides(&mut self, custom: &CustomTheme, diagnostics: &mut Vec<String>) {
        macro_rules! set_color {
            ($field:ident) => {
                if let Some(value) = &custom.$field {
                    match parse_color(value) {
                        Some(color) => self.$field = color,
                        None => diagnostics.push(format!(
                            "invalid theme.custom.{} color {:?}; keeping base value",
                            stringify!($field),
                            value
                        )),
                    }
                }
            };
        }
        set_color!(app_bg);
        set_color!(panel_bg);
        set_color!(canvas_bg);
        set_color!(node_bg);
        set_color!(node_focus_bg);
        set_color!(selection_bg);
        set_color!(surface_dim);
        set_color!(border);
        set_color!(border_focused);
        set_color!(text);
        set_color!(subtext);
        set_color!(muted);
        set_color!(accent);
        set_color!(replay_focus);
        set_color!(running);
        set_color!(success);
        set_color!(warning);
        set_color!(error);
        set_color!(timed_out);
        set_color!(cancelled);
        set_color!(branch);
        set_color!(user);
        set_color!(assistant);
        set_color!(tool);
        set_color!(timeline_track);
        set_color!(timeline_fill);
        set_color!(timeline_thumb);
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ViewerConfig {
    pub theme: ThemeConfig,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ThemeConfig {
    pub name: Option<String>,
    pub auto_switch: bool,
    pub dark_name: Option<String>,
    pub light_name: Option<String>,
    pub custom: CustomTheme,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CustomTheme {
    pub app_bg: Option<String>,
    pub panel_bg: Option<String>,
    pub canvas_bg: Option<String>,
    pub node_bg: Option<String>,
    pub node_focus_bg: Option<String>,
    pub selection_bg: Option<String>,
    pub surface_dim: Option<String>,
    pub border: Option<String>,
    pub border_focused: Option<String>,
    pub text: Option<String>,
    pub subtext: Option<String>,
    pub muted: Option<String>,
    pub accent: Option<String>,
    pub replay_focus: Option<String>,
    pub running: Option<String>,
    pub success: Option<String>,
    pub warning: Option<String>,
    pub error: Option<String>,
    pub timed_out: Option<String>,
    pub cancelled: Option<String>,
    pub branch: Option<String>,
    pub user: Option<String>,
    pub assistant: Option<String>,
    pub tool: Option<String>,
    pub timeline_track: Option<String>,
    pub timeline_fill: Option<String>,
    pub timeline_thumb: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedTheme {
    pub palette: Palette,
    pub config: ThemeConfig,
    pub diagnostics: Vec<String>,
    pub config_path: PathBuf,
}

pub fn config_path() -> PathBuf {
    if let Some(path) = std::env::var_os("PIW_CONFIG_PATH") {
        return PathBuf::from(path);
    }
    if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("piw").join("config.toml");
    }
    std::env::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("piw")
        .join("config.toml")
}

pub fn palette_with_config(name: &str, config: &ThemeConfig) -> (Palette, Vec<String>) {
    let mut diagnostics = Vec::new();
    let mut palette = Palette::from_name(name).unwrap_or_else(|| {
        diagnostics.push(format!(
            "unknown theme {:?}; using catppuccin",
            sanitize_diagnostic(name)
        ));
        Palette::catppuccin()
    });
    palette.apply_overrides(&config.custom, &mut diagnostics);
    (palette, diagnostics)
}

pub fn resolve(cli_theme: Option<&str>) -> ResolvedTheme {
    let path = config_path();
    let mut diagnostics = Vec::new();
    let config = match std::fs::read_to_string(&path) {
        Ok(content) => match toml::from_str::<ViewerConfig>(&content) {
            Ok(config) => config.theme,
            Err(error) => {
                diagnostics.push(format!("failed to parse {}: {error}", path.display()));
                ThemeConfig::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ThemeConfig::default(),
        Err(error) => {
            diagnostics.push(format!("failed to read {}: {error}", path.display()));
            ThemeConfig::default()
        }
    };
    let requested = cli_theme
        .map(str::to_owned)
        .or_else(|| std::env::var("PIW_THEME").ok())
        .or_else(|| config.name.clone())
        .unwrap_or_else(|| "catppuccin".to_string());
    let (palette, mut palette_diagnostics) = palette_with_config(&requested, &config);
    diagnostics.append(&mut palette_diagnostics);
    ResolvedTheme {
        palette,
        config,
        diagnostics,
        config_path: path,
    }
}

pub fn save_theme(path: &Path, name: &str) -> Result<()> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    let mut document = if content.trim().is_empty() {
        DocumentMut::new()
    } else {
        content
            .parse::<DocumentMut>()
            .with_context(|| format!("parsing {}", path.display()))?
    };
    document["theme"]["name"] = value(name);
    document["theme"]["auto_switch"] = value(false);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temp, document.to_string())
        .with_context(|| format!("writing {}", temp.display()))?;
    std::fs::rename(&temp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

pub fn parse_color(input: &str) -> Option<Color> {
    let normalized = input.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "reset" | "default" | "none" | "transparent" => return Some(Color::Reset),
        "black" => return Some(Color::Black),
        "red" => return Some(Color::Red),
        "green" => return Some(Color::Green),
        "yellow" => return Some(Color::Yellow),
        "blue" => return Some(Color::Blue),
        "magenta" | "purple" => return Some(Color::Magenta),
        "cyan" => return Some(Color::Cyan),
        "white" => return Some(Color::White),
        "gray" | "grey" => return Some(Color::Gray),
        "darkgray" | "darkgrey" => return Some(Color::DarkGray),
        "lightred" => return Some(Color::LightRed),
        "lightgreen" => return Some(Color::LightGreen),
        "lightyellow" => return Some(Color::LightYellow),
        "lightblue" => return Some(Color::LightBlue),
        "lightmagenta" => return Some(Color::LightMagenta),
        "lightcyan" => return Some(Color::LightCyan),
        _ => {}
    }
    if let Some(hex) = normalized.strip_prefix('#') {
        return match hex.len() {
            3 => {
                let mut chars = hex.chars();
                Some(Color::Rgb(
                    u8::from_str_radix(&chars.next()?.to_string(), 16).ok()? * 17,
                    u8::from_str_radix(&chars.next()?.to_string(), 16).ok()? * 17,
                    u8::from_str_radix(&chars.next()?.to_string(), 16).ok()? * 17,
                ))
            }
            6 => Some(Color::Rgb(
                u8::from_str_radix(&hex[0..2], 16).ok()?,
                u8::from_str_radix(&hex[2..4], 16).ok()?,
                u8::from_str_radix(&hex[4..6], 16).ok()?,
            )),
            _ => None,
        };
    }
    if let Some(body) = normalized
        .strip_prefix("rgb(")
        .and_then(|value| value.strip_suffix(')'))
    {
        let values = body
            .split(',')
            .map(str::trim)
            .map(str::parse::<u8>)
            .collect::<std::result::Result<Vec<_>, _>>()
            .ok()?;
        if values.len() == 3 {
            return Some(Color::Rgb(values[0], values[1], values[2]));
        }
    }
    None
}

fn normalize_name(name: &str) -> String {
    name.trim().to_ascii_lowercase().replace([' ', '_'], "-")
}

fn sanitize_diagnostic(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    #[test]
    fn every_builtin_resolves_and_nodes_contrast_with_canvas() {
        for name in THEME_NAMES {
            let palette = Palette::from_name(name).expect(name);
            assert_ne!(palette.node_bg, palette.canvas_bg, "{name}");
        }
    }

    #[test]
    fn parses_supported_color_forms() {
        assert_eq!(parse_color("#abc"), Some(Color::Rgb(170, 187, 204)));
        assert_eq!(parse_color("#89b4fa"), Some(Color::Rgb(137, 180, 250)));
        assert_eq!(parse_color("rgb(1, 2, 3)"), Some(Color::Rgb(1, 2, 3)));
        assert_eq!(parse_color("reset"), Some(Color::Reset));
        assert_eq!(parse_color("not-a-color"), None);
    }

    #[test]
    fn config_save_preserves_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "answer = 42\n\n[theme]\nname = \"nord\"\n").unwrap();
        save_theme(&path, "dracula").unwrap();
        let saved = std::fs::read_to_string(path).unwrap();
        assert!(saved.contains("answer = 42"));
        assert!(saved.contains("name = \"dracula\""));
        assert!(saved.contains("auto_switch = false"));
    }

    #[test]
    fn cli_theme_overrides_environment_and_config() {
        let _guard = env_lock();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[theme]\nname = \"nord\"\n").unwrap();
        std::env::set_var("PIW_CONFIG_PATH", &path);
        std::env::set_var("PIW_THEME", "dracula");
        let resolved = resolve(Some("catppuccin-latte"));
        std::env::remove_var("PIW_THEME");
        std::env::remove_var("PIW_CONFIG_PATH");
        assert_eq!(resolved.palette.name, "catppuccin-latte");
    }
}
