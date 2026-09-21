use std::io::{self, Write};
use std::path::Path;

/// Write `bytes` to `path` via a sibling `.tmp` file, then rename into place.
///
/// Unix rename is atomic. On Windows the destination is removed first when it
/// already exists (Win32 rename cannot replace). Still avoids truncating the
/// live file before the new bytes are durable.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = tmp_path(path);
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            if path.exists() {
                std::fs::remove_file(path)?;
                std::fs::rename(&tmp, path)?;
                Ok(())
            } else {
                let _ = std::fs::remove_file(&tmp);
                Err(err)
            }
        }
    }
}

fn tmp_path(path: &Path) -> std::path::PathBuf {
    match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => path.with_file_name(format!("{name}.tmp")),
        None => path.with_extension("tmp"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_creates_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.bin");
        write_atomic(&path, b"one").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"one");
        write_atomic(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert!(!tmp_path(&path).exists());
    }
}
