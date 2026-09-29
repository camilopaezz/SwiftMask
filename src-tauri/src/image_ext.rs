use std::path::Path;

pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp"];

pub fn is_image_filename(name: &str) -> bool {
    let Some(dot) = name.rfind('.') else {
        return false;
    };
    let ext = name[dot + 1..].to_ascii_lowercase();
    IMAGE_EXTENSIONS.iter().any(|e| *e == ext)
}

pub fn is_image_path(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    IMAGE_EXTENSIONS.iter().any(|e| ext.eq_ignore_ascii_case(e))
}
